"""PocketCodes IMAP helper (stdlib only). The browser starts it through native messaging when the extension needs it,
and it reads iCloud and other IMAP inboxes for the extension, which can't open an IMAP connection itself. Installed
once with host/install_host.py; only PocketCodes may talk to it (allowed_extensions / allowed_origins in its manifest).

Read-only: the inbox is opened with EXAMINE and bodies are fetched with BODY.PEEK, so nothing is ever marked read,
moved, flagged or deleted. Passwords live in the operating system's own vault: Windows DPAPI (a blob only this
Windows user can open), the macOS Keychain, or a 0600 file elsewhere. The account list beside them holds no secrets.

Wire format (src/lib/imap.js): one JSON object per message, each prefixed by its length as a native-order uint32.
Requests are { id, op, ... }; answers are { re: id, ok: true, ... } or { re: id, error, auth?, code? }.
  hello                                         -> { version, os, data }
  add     { acct, host, port, user, email, password }  checks the login, keeps the password -> { user }
  remove  { acct }                              forgets the account and its password
  poll    { acct, since, limit }                -> { messages: [{ key, from, subject, text, html?, at }] }
  totp-add { acct, secret, digits?, period?, algo? }  checks the authenticator key, keeps it -> { code, left }
  duo-add { acct, host, code }                  activates PocketCodes as a Duo Mobile device -> { code, counter, name }
  totp    { acct }                              -> { code, left } the authenticator's code now, seconds it has left
                                                   (a Duo one: { code, counter }, good until it's used)
  hotp-used { acct, counter }                   that Duo code was filled or copied: move on to the next one
  texts   { since, limit }                      -> { messages } the Mac's own Messages (texts the iPhone forwards)
A message's key is i:<acct>:<uidvalidity>:<uid> (t:<rowid> for a text); `html` is sent only when a message has no
plain-text part. An authenticator key is kept in the vault like a password and never sent back: only its codes are.
Texts are read from ~/Library/Messages/chat.db, opened read-only, which macOS allows only once the helper's Python
has Full Disk Access; hello's `texts` says whether this machine can do it at all."""
import base64
import email
import hashlib
import hmac
import imaplib
import json
import os
import platform
import re
import sqlite3
import ssl
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from email import policy

VERSION = "0.2.0"
NAME = "io.github.imanimal.pocketcodes"
TEXT_CAP = 16000      # characters of a body passed on; a code is never further in than this
SCAN = 60             # newest UIDs looked at per poll, before the date filter
CACHE_CAP = 300
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
SYSTEM = platform.system()


def data_dir():
    if os.environ.get("POCKETCODES_DATA"):
        return os.environ["POCKETCODES_DATA"]
    if SYSTEM == "Windows":
        return os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "PocketCodes")
    if SYSTEM == "Darwin":
        return os.path.expanduser("~/Library/Application Support/PocketCodes")
    return os.path.join(os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share"), "pocketcodes")


def _path(name):
    return os.path.join(data_dir(), name)


def _load(name):
    try:
        with open(_path(name), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _save(name, obj):
    os.makedirs(data_dir(), exist_ok=True)
    tmp = _path(name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=1)
    os.replace(tmp, _path(name))


# ── the vault ──

def _dpapi(data, protect):
    import ctypes
    from ctypes import wintypes

    class Blob(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    buf = ctypes.create_string_buffer(data, len(data))
    src = Blob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    out = Blob()
    fn = crypt32.CryptProtectData if protect else crypt32.CryptUnprotectData
    if not fn(ctypes.byref(src), None, None, None, None, 0x1, ctypes.byref(out)):  # CRYPTPROTECT_UI_FORBIDDEN
        raise ctypes.WinError()
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        kernel32.LocalFree(ctypes.cast(out.pbData, ctypes.c_void_p))


class Vault:
    """Keeps one password per account id in the operating system's own store."""

    def put(self, acct, password):
        if SYSTEM == "Darwin":
            subprocess.run(["security", "add-generic-password", "-U", "-s", NAME, "-a", acct, "-w", password],
                           check=True, capture_output=True)
            return
        blobs = _load("secrets.json")
        raw = password.encode("utf-8")
        blobs[acct] = base64.b64encode(_dpapi(raw, True) if SYSTEM == "Windows" else raw).decode("ascii")
        _save("secrets.json", blobs)

    def get(self, acct):
        if SYSTEM == "Darwin":
            r = subprocess.run(["security", "find-generic-password", "-s", NAME, "-a", acct, "-w"], capture_output=True, text=True)
            return r.stdout.rstrip("\n") if r.returncode == 0 else None
        blob = _load("secrets.json").get(acct)
        if not blob:
            return None
        raw = base64.b64decode(blob)
        return (_dpapi(raw, False) if SYSTEM == "Windows" else raw).decode("utf-8")

    def drop(self, acct):
        if SYSTEM == "Darwin":
            subprocess.run(["security", "delete-generic-password", "-s", NAME, "-a", acct], capture_output=True)
            return
        blobs = _load("secrets.json")
        if blobs.pop(acct, None) is not None:
            _save("secrets.json", blobs)


# ── reading mail ──

class Fail(Exception):
    def __init__(self, msg, auth=False, code=None):
        super().__init__(msg)
        self.auth = auth
        self.code = code


def imap_date(ms):
    t = time.gmtime(ms / 1000 - 86400)  # a day early: SINCE is by the server's calendar date, not ours
    return f"{t.tm_mday:02d}-{MONTHS[t.tm_mon - 1]}-{t.tm_year}"


def body_of(raw):
    """(from, subject, text, html) of an RFC 822 message; text is empty when it has only an HTML part."""
    msg = email.message_from_bytes(raw, policy=policy.default)
    text = html = ""
    try:
        part = msg.get_body(preferencelist=("plain",))
        if part is not None:
            text = part.get_content()
        else:
            part = msg.get_body(preferencelist=("html",))
            if part is not None:
                html = part.get_content()
    except (LookupError, ValueError, UnicodeError):
        text = ""
    return str(msg.get("from", "")), str(msg.get("subject", "")), text[:TEXT_CAP], html[:TEXT_CAP * 4]


class Mailbox:
    """One account's IMAP connection, kept open between polls."""

    def __init__(self, acct, conf, password, opener=None):
        self.acct = acct
        self.conf = conf
        self.password = password
        self.opener = opener or (lambda host, port: imaplib.IMAP4_SSL(host, port, ssl_context=ssl.create_default_context(), timeout=25))
        self.conn = None
        self.cache = {}
        self.lock = threading.Lock()

    def login(self):
        c = self.opener(self.conf["host"], int(self.conf.get("port") or 993))
        try:
            c.login(self.conf["user"], self.password)
        except imaplib.IMAP4.error as e:
            try:
                c.logout()
            except Exception:
                pass
            raise Fail(f"{self.conf['host']} didn't accept the login ({_short(e)}). Check the address and the app password.", auth=True)
        self.conn = c
        return c

    def close(self):
        if self.conn is not None:
            try:
                self.conn.logout()
            except Exception:
                pass
        self.conn = None

    def poll(self, since, limit):
        with self.lock:
            for attempt in (0, 1):
                try:
                    return self._poll(since, limit)
                except (imaplib.IMAP4.abort, OSError, ssl.SSLError) as e:
                    self.close()
                    if attempt:
                        raise Fail(f"Couldn't reach {self.conf['host']} ({_short(e)}).")

    def _poll(self, since, limit):
        c = self.conn or self.login()
        typ, _ = c.select("INBOX", readonly=True)  # EXAMINE: nothing gets marked read
        if typ != "OK":
            raise Fail("The server wouldn't open the inbox.")
        validity = (c.response("UIDVALIDITY")[1] or [b"0"])[0]
        validity = validity.decode() if isinstance(validity, bytes) else str(validity)
        typ, data = c.uid("SEARCH", None, "SINCE", imap_date(since))
        uids = (data[0] or b"").split()[-SCAN:] if typ == "OK" and data else []
        if not uids:
            return []
        typ, data = c.uid("FETCH", b",".join(uids).decode(), "(INTERNALDATE)")
        dated = []
        for item in data or []:
            line = item[0] if isinstance(item, tuple) else item
            if not isinstance(line, bytes):
                continue
            m = re.search(rb"UID (\d+)", line)
            t = imaplib.Internaldate2tuple(line)
            if m and t:
                at = int(time.mktime(t) * 1000)
                if at >= since:
                    dated.append((at, m.group(1).decode()))
        dated.sort(reverse=True)
        out = []
        for at, uid in dated[:limit]:
            key = f"i:{self.acct}:{validity}:{uid}"
            if key not in self.cache:
                typ, data = c.uid("FETCH", uid, "(BODY.PEEK[])")
                raw = next((x[1] for x in data or [] if isinstance(x, tuple) and isinstance(x[1], bytes)), None)
                if raw is None:
                    continue
                frm, subject, text, html = body_of(raw)
                rec = {"key": key, "from": frm, "subject": subject, "text": text, "at": at}
                if not text and html:
                    rec["html"] = html
                self.cache[key] = rec
                while len(self.cache) > CACHE_CAP:
                    self.cache.pop(next(iter(self.cache)))
            out.append(self.cache[key])
        return out


# ── authenticator codes (RFC 4226 and 6238) ──

ALGOS = {"SHA1": hashlib.sha1, "SHA256": hashlib.sha256, "SHA512": hashlib.sha512}


def b32key(secret):
    """The bytes of a base32 authenticator key, however it was typed (spaces, dashes, lower case, no padding)."""
    s = re.sub(r"[\s-]+", "", str(secret or "")).upper().rstrip("=")
    if not s or not re.fullmatch(r"[A-Z2-7]+", s):
        raise Fail("That isn't an authenticator key: it should be letters A to Z and digits 2 to 7.")
    key = base64.b32decode(s + "=" * (-len(s) % 8))
    if len(key) < 10:
        raise Fail("That key is too short for an authenticator. Copy the whole key the site shows.")
    return key


def hotp(key, counter, digits=6, algo="SHA1"):
    """The code for `key` at `counter` (RFC 4226)."""
    mac = hmac.new(key, struct.pack(">Q", counter), ALGOS.get(algo, hashlib.sha1)).digest()
    o = mac[-1] & 0x0F
    n = (struct.unpack(">I", mac[o:o + 4])[0] & 0x7FFFFFFF) % (10 ** digits)
    return str(n).zfill(digits)


def totp(key, at=None, digits=6, period=30, algo="SHA1"):
    """(code, seconds left) for `key` at time `at` (now)."""
    at = time.time() if at is None else at
    return hotp(key, int(at // period), digits, algo), int(period - at % period)


# ── Duo passcodes ──
# A school's or company's Duo account has no key to copy: Duo Mobile gets one when it's activated as a device. The
# helper activates PocketCodes the same way, as one more device on the account (a tablet, so the phone keeps its
# own): the code in Duo's "add a device" QR code goes to the activation request Duo Mobile makes, and the answer's
# hotp_secret, as text, is the key for RFC 4226 codes counted from 0. Duo takes a code until it or a later one has
# been used, so the count moves on only when a code is filled or copied (hotp-used). This isn't an interface Duo
# documents; it's what Duo Mobile itself sends.

DUO_HOST = re.compile(r"api-[a-z0-9-]+\.duo(?:security|federal)\.com")
DUO_CODE = re.compile(r"[A-Za-z0-9]{10,64}")
# how Duo Mobile on an Android tablet describes itself; the model is what Duo's device list shows
DUO_DEVICE = {"jailbroken": "false", "architecture": "arm64", "region": "US", "app_id": "com.duosecurity.duomobile",
              "full_disk_encryption": "true", "passcode_status": "true", "platform": "Android", "app_version": "4.70.0",
              "app_build_number": "470000", "version": "14", "manufacturer": "unknown", "language": "en",
              "model": "PocketCodes", "security_patch_level": "2025-01-01"}
DUO_AHEAD = 20  # how far past the current count a "used" may move it


def duo_post(url, form):
    """POSTs a form to Duo: (HTTP status, body)."""
    req = urllib.request.Request(url, data=urllib.parse.urlencode(form).encode("ascii"), method="POST",
                                 headers={"User-Agent": "okhttp/2.7.5", "Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=20, context=ssl.create_default_context()) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except (urllib.error.URLError, OSError) as e:
        raise Fail(f"Couldn't reach Duo ({_short(getattr(e, 'reason', e))}).")


def duo_activate(host, code, post=None):
    """Activates a device with Duo: (hotp_secret, the organization's name)."""
    if not DUO_HOST.fullmatch(host or "") or not DUO_CODE.fullmatch(code or ""):
        raise Fail("That isn't a Duo activation code. Copy the QR code's link again.")
    status, body = (post or duo_post)(f"https://{host}/push/v2/activation/{code}?customer_protocol=1", DUO_DEVICE)
    try:
        res = json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeError, AttributeError):
        res = None
    if not isinstance(res, dict):
        raise Fail(f"Duo answered with something PocketCodes doesn't understand (HTTP {status}).")
    if res.get("stat") != "OK":
        why = res.get("message_detail") or res.get("message") or f"HTTP {status}"
        raise Fail(f"Duo didn't take that code ({why}). An activation code works once, for a day: ask Duo for a new one.")
    r = res.get("response") or {}
    if not isinstance(r.get("hotp_secret"), str) or not r["hotp_secret"]:
        raise Fail("Duo added PocketCodes as a device but sent no passcode key, so it can't make Duo codes. "
                   "Remove the new device in Duo's device list.")
    return r["hotp_secret"], str(r.get("customer_name") or "")


# ── texts on a Mac ──

APPLE_EPOCH = 978307200  # 2001-01-01 in Unix seconds, where Messages counts from


def chat_db():
    return os.environ.get("POCKETCODES_CHATDB") or os.path.expanduser("~/Library/Messages/chat.db")


def body_text(blob):
    """The text in a message's attributedBody (an archived NSAttributedString), for messages whose `text` is empty."""
    if not blob:
        return ""
    i = blob.find(b"NSString")
    j = blob.find(b"+", i) if i >= 0 else -1
    if j < 0 or j + 2 > len(blob):
        return ""
    n, k = blob[j + 1], j + 2
    if n == 0x81:  # a longer string: the length follows in two bytes
        n, k = int.from_bytes(blob[k:k + 2], "little"), k + 2
    return blob[k:k + n].decode("utf-8", "replace")


def read_texts(since, limit):
    path = chat_db()
    if SYSTEM != "Darwin" and not os.environ.get("POCKETCODES_CHATDB"):
        raise Fail("Texts can only be read on a Mac (Messages with Text Message Forwarding from your iPhone).", code="not-mac")
    try:
        db = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
    except sqlite3.Error as e:
        raise Fail(f"Couldn't open Messages ({_short(e)}).")
    try:
        newest = db.execute("SELECT MAX(date) FROM message").fetchone()[0] or 0
        # Messages has counted in nanoseconds since macOS 10.13, in seconds before that
        scale = 1e9 if newest > 1e12 else 1
        rows = db.execute(
            "SELECT m.ROWID, m.text, m.attributedBody, m.date, h.id FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id"
            " WHERE m.is_from_me = 0 AND m.date >= ? ORDER BY m.date DESC LIMIT ?",
            (int((since / 1000 - APPLE_EPOCH) * scale), limit)).fetchall()
    except sqlite3.Error as e:
        if re.search(r"unable to open|authoriz|not permitted|no such table", str(e), re.I):
            # macOS asks about the app that started the helper (the browser), not the helper's own Python
            raise Fail("macOS isn't letting PocketCodes read Messages yet. System Settings → Privacy & Security → "
                       "Full Disk Access → turn on your browser (Firefox), restart it, then check again.", code="no-access")
        raise Fail(f"Couldn't read Messages ({_short(e)}).")
    finally:
        db.close()
    out = []
    for rowid, text, blob, date, sender in rows:
        body = text or body_text(blob)
        if body:
            out.append({"key": f"t:{rowid}", "from": sender or "Text message", "subject": "", "text": body[:TEXT_CAP],
                        "at": int((date / scale + APPLE_EPOCH) * 1000)})
    return out


def _short(e):
    s = e.args[0] if getattr(e, "args", None) else e
    s = s.decode("utf-8", "replace") if isinstance(s, bytes) else str(s)
    return s.strip()[:160] or type(e).__name__


# ── the helper ──

class Helper:
    def __init__(self, vault=None, opener=None, post=None):
        self.vault = vault or Vault()
        self.opener = opener
        self.post = post
        self.boxes = {}
        self.lock = threading.Lock()
        self.count_lock = threading.Lock()  # a Duo code's count is read, moved on and written back as one step

    def otp(self, acct):
        raw = self.vault.get(acct)
        if not raw:
            raise Fail("The helper doesn't have this authenticator's key. Remove it and add it again.", auth=True)
        return json.loads(raw)

    @staticmethod
    def duo_code(conf):
        return {"code": hotp(conf["secret"].encode("utf-8"), conf["counter"], conf.get("digits", 6)), "counter": conf["counter"]}

    def box(self, acct):
        with self.lock:
            if acct in self.boxes:
                return self.boxes[acct]
            conf = _load("accounts.json").get(acct)
            password = conf and self.vault.get(acct)
            if not conf or not password:
                raise Fail("The helper doesn't have this account's password. Remove it and add it again.", auth=True)
            b = self.boxes[acct] = Mailbox(acct, conf, password, self.opener)
            return b

    def handle(self, req):
        op = req.get("op")
        if op == "hello":
            return {"version": VERSION, "os": {"Darwin": "macOS"}.get(SYSTEM, SYSTEM), "data": data_dir(),
                    "texts": SYSTEM == "Darwin", "totp": True, "duo": True}
        if op == "totp-add":
            acct = str(req.get("acct") or "")
            conf = {"secret": base64.b32encode(b32key(req.get("secret"))).decode("ascii"),
                    "digits": int(req.get("digits") or 6), "period": int(req.get("period") or 30),
                    "algo": str(req.get("algo") or "SHA1").upper()}
            if not acct.startswith("totp:") or conf["digits"] not in (6, 7, 8) or conf["algo"] not in ALGOS or not 10 <= conf["period"] <= 120:
                raise Fail("That authenticator setting isn't one PocketCodes can make codes for.")
            self.vault.put(acct, json.dumps(conf))
            code, left = totp(b32key(conf["secret"]), None, conf["digits"], conf["period"], conf["algo"])
            return {"code": code, "left": left}
        if op == "duo-add":
            acct = str(req.get("acct") or "")
            if not acct.startswith("duo:"):
                raise Fail("That isn't a Duo account PocketCodes can add.")
            secret, name = duo_activate(str(req.get("host") or ""), str(req.get("code") or ""), self.post)
            conf = {"kind": "hotp", "secret": secret, "counter": 0, "digits": 6}
            with self.count_lock:
                self.vault.put(acct, json.dumps(conf))
            return dict(self.duo_code(conf), name=name)
        if op == "totp":
            conf = self.otp(str(req.get("acct") or ""))
            if conf.get("kind") == "hotp":
                return self.duo_code(conf)
            code, left = totp(b32key(conf["secret"]), None, conf["digits"], conf["period"], conf["algo"])
            return {"code": code, "left": left}
        if op == "hotp-used":
            acct = str(req.get("acct") or "")
            with self.count_lock:
                conf = self.otp(acct)
                if conf.get("kind") != "hotp":
                    raise Fail("That authenticator's codes go by the clock, not by use.")
                used = int(req.get("counter") if req.get("counter") is not None else -1)
                # a code already passed changes nothing; one too far ahead isn't one PocketCodes gave out
                if conf["counter"] <= used <= conf["counter"] + DUO_AHEAD:
                    conf["counter"] = used + 1
                    self.vault.put(acct, json.dumps(conf))
                return self.duo_code(conf)
        if op == "texts":
            since = int(req.get("since") or (time.time() - 1800) * 1000)
            return {"messages": read_texts(since, max(1, min(50, int(req.get("limit") or 20))))}
        if op == "add":
            return self.add(req)
        if op == "remove":
            acct = str(req.get("acct") or "")
            with self.lock:
                b = self.boxes.pop(acct, None)
            if b:
                b.close()
            accounts = _load("accounts.json")
            if accounts.pop(acct, None) is not None:
                _save("accounts.json", accounts)
            self.vault.drop(acct)
            return {}
        if op == "poll":
            since = int(req.get("since") or (time.time() - 1800) * 1000)
            return {"messages": self.box(str(req.get("acct") or "")).poll(since, max(1, min(50, int(req.get("limit") or 20))))}
        raise Fail(f"Unknown request: {op}")

    def add(self, req):
        acct, host, password = str(req.get("acct") or ""), str(req.get("host") or "").strip(), str(req.get("password") or "")
        if not acct or not host or not password:
            raise Fail("The account, server and password are all needed.")
        user = str(req.get("user") or req.get("email") or "").strip()
        # iCloud has taken both the full address and the part before the @ over the years
        tries = [user] + ([user.split("@")[0]] if "@" in user and host.endswith("mail.me.com") else [])
        err = None
        for u in tries:
            conf = {"host": host, "port": int(req.get("port") or 993), "user": u, "email": str(req.get("email") or u)}
            b = Mailbox(acct, conf, password, self.opener)
            try:
                b.login()
            except Fail as e:
                err = e
                continue
            except (OSError, ssl.SSLError) as e:
                raise Fail(f"Couldn't reach {host} ({_short(e)}).")
            self.vault.put(acct, password)
            accounts = _load("accounts.json")
            accounts[acct] = conf
            _save("accounts.json", accounts)
            with self.lock:
                old = self.boxes.pop(acct, None)
                self.boxes[acct] = b
            if old:
                old.close()
            return {"user": u}
        raise err


def read_msg(stream):
    head = stream.read(4)
    if len(head) < 4:
        return None
    n = struct.unpack("=I", head)[0]
    return json.loads(stream.read(n).decode("utf-8"))


def write_msg(stream, obj):
    data = json.dumps(obj).encode("utf-8")
    stream.write(struct.pack("=I", len(data)))
    stream.write(data)
    stream.flush()


def serve(inp, out, helper=None):
    helper = helper or Helper()
    wlock = threading.Lock()

    def answer(req):
        rid = req.get("id")
        try:
            res = dict(helper.handle(req), re=rid, ok=True)
        except Fail as e:
            res = {"re": rid, "error": str(e), "auth": e.auth}
            if e.code:
                res["code"] = e.code
        except Exception as e:  # anything unexpected still gets an answer, so the extension isn't left waiting
            res = {"re": rid, "error": f"The helper hit a problem: {_short(e)}"}
        with wlock:
            write_msg(out, res)

    threads = []
    while True:
        req = read_msg(inp)
        if req is None:
            break
        t = threading.Thread(target=answer, args=(req,), daemon=True)
        t.start()
        threads.append(t)
        threads = [x for x in threads if x.is_alive()]
    for t in threads:
        t.join(timeout=5)


def main():
    inp, out = sys.stdin.buffer, sys.stdout.buffer
    sys.stdout = sys.stderr  # a stray print must never land in the message stream
    serve(inp, out)


if __name__ == "__main__":
    main()
