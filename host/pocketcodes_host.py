#!/usr/bin/env python3
"""PocketCodes IMAP helper.

A browser extension can't open an IMAP connection, so the browser starts this script through native messaging
and talks to it over stdin/stdout. It uses nothing but the Python standard library.

What it does, and what it never does:
  - It logs in to an IMAP server with the password you type once in PocketCodes' settings, and keeps that
    password in the operating system's own vault: Windows DPAPI (bound to your Windows sign-in), the macOS
    Keychain, or on Linux a file only your user can read. The extension never stores it.
  - It opens INBOX read-only (EXAMINE) and reads messages with BODY.PEEK, so nothing is marked read, moved,
    flagged, deleted or sent. It reads the first 30 KB of recent messages and hands their text to the
    extension, which looks for a code and keeps only the code. Nothing is written to disk but the account list
    (server, port, login: no password) and the vault.
  - It only answers the extension named in its native-messaging manifest; the browser enforces that.

Wire format (native messaging: a 4-byte little-endian length, then that many bytes of UTF-8 JSON, each way):
  requests  {id, op, ...}
  answers   {re: id, ok: true, ...}  or  {re: id, error, auth?, code?}
  ops       hello  {}                                          -> {version, os, data}
            add    {acct, host, port, user, email, password}   -> {user}   (the login that worked)
            remove {acct}                                      -> {}
            poll   {acct, since, limit, skip?}                 -> {messages: [{key, from, subject, text, at}]}
  Message keys are "i:<acct>:<uidvalidity>:<uid>". An account the helper doesn't know answers auth: true.

Install it with host/install_host.py; the extension's settings page shows the command.
"""

import base64
import email
import email.policy
import email.utils
import html
import imaplib
import json
import os
import re
import socket
import ssl
import struct
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

VERSION = "0.1.0"
SERVICE = "PocketCodes"
PEEK_BYTES = 30000
TEXT_CAP = 8000
TIMEOUT = 20
LOOK_BACK_MS = 30 * 60 * 1000
APPLE_DOMAINS = ("icloud.com", "me.com", "mac.com")
LOCAL_HOSTS = ("127.0.0.1", "localhost", "::1")


class Fail(Exception):
    """An error the extension shows as it is."""

    def __init__(self, message, auth=False, code=None):
        super().__init__(message)
        self.auth = auth
        self.code = code


# ── where things live ──

def os_name():
    if sys.platform.startswith("win"):
        return "windows"
    if sys.platform == "darwin":
        return "macos"
    return "linux"


def data_dir():
    """%APPDATA%\\PocketCodes, ~/Library/Application Support/PocketCodes or $XDG_DATA_HOME/pocketcodes.
    POCKETCODES_DATA overrides it (the tests use that)."""
    env = os.environ.get("POCKETCODES_DATA")
    if env:
        return env
    name = os_name()
    if name == "windows":
        return os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~\\AppData\\Roaming"), "PocketCodes")
    if name == "macos":
        return os.path.expanduser("~/Library/Application Support/PocketCodes")
    return os.path.join(os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share"), "pocketcodes")


def _ensure_dir():
    d = data_dir()
    os.makedirs(d, exist_ok=True)
    if os_name() != "windows":
        try:
            os.chmod(d, 0o700)
        except OSError:
            pass
    return d


def _read_json(name, default):
    try:
        with open(os.path.join(data_dir(), name), "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def _write_json(name, value):
    """Writes atomically, readable by this user only on macOS and Linux."""
    d = _ensure_dir()
    path = os.path.join(d, name)
    tmp = path + ".tmp"
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    fd = os.open(tmp, flags, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(value, f, indent=1, sort_keys=True)
    os.replace(tmp, path)


def log(text):
    """A short log for troubleshooting: errors only, never a password or message text."""
    try:
        path = os.path.join(_ensure_dir(), "helper.log")
        if os.path.exists(path) and os.path.getsize(path) > 100000:
            os.replace(path, path + ".old")
        with open(path, "a", encoding="utf-8") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + str(text)[:500].replace("\n", " ") + "\n")
    except OSError:
        pass


# ── the vault ──

class FileVault:
    """vault.json in the data dir: {account: base64 of the stored bytes}. `seal`/`open_` wrap each value."""

    FILE = "vault.json"

    def __init__(self):
        self.lock = threading.Lock()

    def seal(self, data):
        return data

    def open_(self, data):
        return data

    def set(self, acct, password):
        with self.lock:
            v = _read_json(self.FILE, {})
            v[acct] = base64.b64encode(self.seal(password.encode("utf-8"))).decode("ascii")
            _write_json(self.FILE, v)

    def get(self, acct):
        with self.lock:
            raw = _read_json(self.FILE, {}).get(acct)
        if raw is None:
            return None
        return self.open_(base64.b64decode(raw)).decode("utf-8")

    def delete(self, acct):
        with self.lock:
            v = _read_json(self.FILE, {})
            if acct in v:
                del v[acct]
                _write_json(self.FILE, v)


class LinuxVault(FileVault):
    """A file only this user can read (0600, in a 0700 folder). Base64, which is not encryption: on Linux the
    protection is the file permissions, the same as a browser profile's."""

    kind = "file"


class WindowsVault(FileVault):
    """DPAPI (CryptProtectData), so only this Windows user on this computer can unseal the blobs."""

    kind = "dpapi"
    ENTROPY = b"PocketCodes IMAP helper"

    def __init__(self):
        super().__init__()
        import ctypes
        from ctypes import wintypes

        class Blob(ctypes.Structure):
            _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

        self.ctypes = ctypes
        self.Blob = Blob
        self.crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
        self.kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        P = ctypes.POINTER(Blob)
        self.crypt32.CryptProtectData.argtypes = [P, wintypes.LPCWSTR, P, ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, P]
        self.crypt32.CryptProtectData.restype = wintypes.BOOL
        self.crypt32.CryptUnprotectData.argtypes = [P, ctypes.c_void_p, P, ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, P]
        self.crypt32.CryptUnprotectData.restype = wintypes.BOOL
        self.kernel32.LocalFree.argtypes = [ctypes.c_void_p]
        self.kernel32.LocalFree.restype = ctypes.c_void_p

    def _blob(self, data):
        c = self.ctypes
        buf = c.create_string_buffer(data, len(data))
        return self.Blob(len(data), c.cast(buf, c.POINTER(c.c_char))), buf

    def _run(self, fn, data, *extra):
        c = self.ctypes
        inp, keep1 = self._blob(data)
        ent, keep2 = self._blob(self.ENTROPY)
        out = self.Blob()
        CRYPTPROTECT_UI_FORBIDDEN = 0x01
        if not fn(c.byref(inp), *extra, c.byref(ent), None, None, CRYPTPROTECT_UI_FORBIDDEN, c.byref(out)):
            raise Fail("Windows couldn't use its password vault (DPAPI error %d)." % c.get_last_error(), code="vault")
        try:
            return c.string_at(out.pbData, out.cbData)
        finally:
            self.kernel32.LocalFree(c.cast(out.pbData, c.c_void_p))

    def seal(self, data):
        return self._run(self.crypt32.CryptProtectData, data, SERVICE)

    def open_(self, data):
        return self._run(self.crypt32.CryptUnprotectData, data, None)


class MacVault:
    """The login Keychain, through /usr/bin/security. The password goes to `security -i` on stdin, never in
    argv where other processes could see it. It is stored hex-encoded so no quoting or non-ASCII can break the
    command line; Keychain Access shows the item as "PocketCodes" with that hex as its password."""

    kind = "keychain"
    SECURITY = "/usr/bin/security"
    SAFE = re.compile(r"^[A-Za-z0-9@._+:\-]+$")

    def _account(self, acct):
        if not self.SAFE.match(acct):
            raise Fail("That account name can't go in the Keychain.", code="vault")
        return acct

    def set(self, acct, password):
        a = self._account(acct)
        hexpw = password.encode("utf-8").hex()
        cmd = 'add-generic-password -U -a "%s" -s "%s" -l "%s" -w "%s"\n' % (a, SERVICE, SERVICE, hexpw)
        r = subprocess.run([self.SECURITY, "-i"], input=cmd.encode("ascii"), capture_output=True, timeout=30)
        if r.returncode != 0 or b"error" in r.stderr.lower():
            raise Fail("The Keychain didn't take the password: " + r.stderr.decode("utf-8", "replace").strip()[:200], code="vault")

    def get(self, acct):
        a = self._account(acct)
        r = subprocess.run([self.SECURITY, "find-generic-password", "-a", a, "-s", SERVICE, "-w"], capture_output=True, timeout=30)
        if r.returncode != 0:
            return None
        try:
            return bytes.fromhex(r.stdout.decode("ascii").strip()).decode("utf-8")
        except ValueError:
            raise Fail("The Keychain item for this account isn't one PocketCodes wrote. Remove and add the account again.", auth=True, code="vault")

    def delete(self, acct):
        a = self._account(acct)
        subprocess.run([self.SECURITY, "delete-generic-password", "-a", a, "-s", SERVICE], capture_output=True, timeout=30)


_vault = None
_vault_lock = threading.Lock()


def vault():
    """The vault for this OS. There is no plaintext fallback on Windows or macOS: if the OS vault can't be
    used, adding an account fails with that error."""
    global _vault
    with _vault_lock:
        if _vault is None:
            name = os_name()
            _vault = WindowsVault() if name == "windows" else MacVault() if name == "macos" else LinuxVault()
        return _vault


# ── accounts (no secrets) ──

_acct_lock = threading.Lock()


def load_accounts():
    with _acct_lock:
        return _read_json("accounts.json", {})


def save_account(acct, rec):
    with _acct_lock:
        a = _read_json("accounts.json", {})
        if rec is None:
            a.pop(acct, None)
        else:
            a[acct] = rec
        _write_json("accounts.json", a)


# ── IMAP ──

def _server_text(e):
    s = e.args[0] if e.args else str(e)
    if isinstance(s, bytes):
        s = s.decode("utf-8", "replace")
    return str(s)


def connect(host, port, plain=False):
    if plain and host not in LOCAL_HOSTS:
        raise Fail("Unencrypted IMAP is only for the tests on this computer.", code="tls")
    try:
        if plain:
            return imaplib.IMAP4(host, port, timeout=TIMEOUT)
        return imaplib.IMAP4_SSL(host, port, ssl_context=ssl.create_default_context(), timeout=TIMEOUT)
    except socket.gaierror:
        raise Fail("Can't find the server %s. Check the name." % host, code="net")
    except ssl.SSLCertVerificationError:
        raise Fail("The certificate of %s didn't check out, so PocketCodes didn't send the password." % host, code="tls")
    except (socket.timeout, TimeoutError):
        raise Fail("%s didn't answer in time." % host, code="net")
    except ConnectionRefusedError:
        raise Fail("%s refused the connection on port %s." % (host, port), code="net")
    except (OSError, imaplib.IMAP4.error) as e:
        raise Fail("Couldn't connect to %s: %s" % (host, _server_text(e) or type(e).__name__), code="net")


def login(conn, user, password):
    try:
        conn.login(user, password)
    except UnicodeEncodeError:
        raise Fail("This server only takes plain ASCII logins and passwords.", auth=True, code="login")
    except imaplib.IMAP4.abort:
        raise
    except imaplib.IMAP4.error as e:
        raise Fail("The server didn't accept that login (%s). iCloud and Yahoo need an app-specific password." % _server_text(e)[:120], auth=True, code="login")


def login_candidates(user, email_addr):
    """The login to try first, then for iCloud the part before the @, which Apple accepts for older accounts."""
    out = [user or email_addr]
    addr = (email_addr or user or "").lower()
    if "@" in addr and addr.rsplit("@", 1)[1] in APPLE_DOMAINS:
        local = addr.split("@", 1)[0]
        if local not in out:
            out.append(local)
    return out


def close(conn):
    try:
        conn.logout()
    except Exception:
        try:
            conn.shutdown()
        except Exception:
            pass


MONTHS = {m: i + 1 for i, m in enumerate("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split())}
INTERNALDATE = re.compile(rb'INTERNALDATE "\s*(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d\d):(\d\d):(\d\d) ([+-])(\d\d)(\d\d)"')


def internaldate_ms(meta):
    """INTERNALDATE "02-Nov-2026 10:15:00 -0800" as epoch milliseconds, or None. No locale involved."""
    m = INTERNALDATE.search(meta)
    if not m:
        return None
    d, mon, y, hh, mm, ss, sign, oh, om = m.groups()
    month = MONTHS.get(mon.decode("ascii").title())
    if not month:
        return None
    import calendar
    t = calendar.timegm((int(y), month, int(d), int(hh), int(mm), int(ss), 0, 0, 0))
    off = (int(oh) * 3600 + int(om) * 60) * (1 if sign == b"+" else -1)
    return (t - off) * 1000


def imap_date(ms):
    """An IMAP SEARCH date (dd-Mon-yyyy) a day before `ms`, since SINCE counts whole days in the server's zone."""
    t = time.gmtime(ms / 1000 - 86400)
    return "%02d-%s-%04d" % (t.tm_mday, list(MONTHS)[t.tm_mon - 1], t.tm_year)


TAGS_BLOCK = re.compile(r"<(style|script|head|title)\b[\s\S]*?</\1\s*>", re.I)
TAGS_BREAK = re.compile(r"<br\s*/?>|</(p|div|tr|li|h[1-6]|table|section|blockquote)\s*>", re.I)
TAGS_CELL = re.compile(r"</t[dh]\s*>", re.I)
TAGS_ANY = re.compile(r"<[^>]*>")
COMMENTS = re.compile(r"<!--[\s\S]*?-->")


def html_to_text(s):
    s = TAGS_BLOCK.sub(" ", s)
    s = COMMENTS.sub(" ", s)
    s = TAGS_BREAK.sub("\n", s)
    s = TAGS_CELL.sub(" ", s)
    s = TAGS_ANY.sub(" ", s)
    s = html.unescape(s)
    s = re.sub(r"[ \t\r\f\v]+", " ", s)
    return re.sub(r"\n\s*\n+", "\n\n", s).strip()


def _part_text(part):
    try:
        return part.get_content()
    except Exception:
        raw = part.get_payload(decode=True) or b""
        return raw.decode(part.get_content_charset() or "utf-8", "replace") if isinstance(raw, bytes) else str(raw)


def message_text(msg):
    """The text/plain parts, else the HTML parts as text. Attachments are skipped."""
    plain, rich = [], []
    for part in msg.walk():
        if part.is_multipart() or part.get_content_disposition() == "attachment":
            continue
        ctype = part.get_content_type()
        if ctype == "text/plain":
            plain.append(_part_text(part))
        elif ctype == "text/html":
            rich.append(html_to_text(_part_text(part)))
    text = "\n".join(plain) if any(p.strip() for p in plain) else "\n".join(rich)
    return text[:TEXT_CAP]


def parse_message(raw):
    msg = email.message_from_bytes(raw, policy=email.policy.default)

    def header(name):
        try:
            return str(msg.get(name, "") or "")
        except Exception:
            return ""

    date_ms = None
    try:
        d = email.utils.parsedate_to_datetime(header("date"))
        date_ms = int(d.timestamp() * 1000) if d else None
    except Exception:
        pass
    return {"from": header("from"), "subject": header("subject")[:300], "text": message_text(msg), "date": date_ms}


UID = re.compile(rb"\bUID (\d+)")


def fetch_parts(data):
    """imaplib's FETCH answer as [(uid, meta bytes, raw message bytes)]. Servers may put UID and INTERNALDATE
    before or after the literal, so the bytes on either side of it count as meta."""
    out = []
    for i, item in enumerate(data):
        if not isinstance(item, tuple):
            continue
        meta = item[0]
        nxt = data[i + 1] if i + 1 < len(data) else b""
        if isinstance(nxt, bytes):
            meta += b" " + nxt
        m = UID.search(meta)
        if m:
            out.append((int(m.group(1)), meta, item[1]))
    return out


class Account:
    """One account's connection, reused between checks and opened again after any error."""

    def __init__(self, acct):
        self.acct = acct
        self.conn = None
        self.lock = threading.Lock()

    def drop(self):
        if self.conn is not None:
            close(self.conn)
        self.conn = None

    def _open(self):
        rec = load_accounts().get(self.acct)
        if not rec:
            raise Fail("The helper doesn't know this account. Add it again.", auth=True, code="unknown")
        pw = vault().get(self.acct)
        if pw is None:
            raise Fail("The helper has no password for this account. Add it again.", auth=True, code="unknown")
        conn = connect(rec["host"], int(rec["port"]), bool(rec.get("plain")))
        try:
            login(conn, rec["user"], pw)
        except BaseException:
            close(conn)
            raise
        self.conn = conn

    def poll(self, since, limit, skip):
        with self.lock:
            for attempt in (0, 1):
                try:
                    if self.conn is None:
                        self._open()
                    return self._poll(since, limit, skip)
                except (imaplib.IMAP4.abort, OSError, ssl.SSLError) as e:
                    self.drop()
                    if attempt:
                        raise Fail("Lost the connection to the server: %s" % (_server_text(e) or type(e).__name__), code="net")
                except Fail:
                    self.drop()
                    raise
                except imaplib.IMAP4.error as e:
                    self.drop()
                    raise Fail("The server said: %s" % _server_text(e)[:200], code="imap")

    def _poll(self, since, limit, skip):
        c = self.conn
        typ, _ = c.select("INBOX", readonly=True)   # EXAMINE
        if typ != "OK":
            raise Fail("Couldn't open INBOX.", code="imap")
        uv = (c.response("UIDVALIDITY")[1] or [b"0"])[-1]
        uv = int(uv) if uv and uv.isdigit() else 0
        typ, data = c.uid("SEARCH", "SINCE", imap_date(since))
        if typ != "OK":
            raise Fail("The server wouldn't search INBOX.", code="imap")
        uids = sorted({int(x) for x in b" ".join(d for d in data if d).split()})[-limit:]
        key = lambda u: "i:%s:%d:%d" % (self.acct, uv, u)
        want = [u for u in uids if key(u) not in skip]
        if not want:
            return []
        typ, data = c.uid("FETCH", ",".join(map(str, want)), "(UID INTERNALDATE BODY.PEEK[]<0.%d>)" % PEEK_BYTES)
        if typ != "OK":
            raise Fail("The server wouldn't send the messages.", code="imap")
        out = []
        for uid, meta, raw in fetch_parts(data):
            m = parse_message(raw)
            at = internaldate_ms(meta) or m["date"] or int(time.time() * 1000)
            if at < since:
                continue
            out.append({"key": key(uid), "from": m["from"], "subject": m["subject"], "text": m["text"], "at": at})
        out.sort(key=lambda x: -x["at"])
        return out


_accts = {}
_accts_lock = threading.Lock()


def account(acct):
    with _accts_lock:
        if acct not in _accts:
            _accts[acct] = Account(acct)
        return _accts[acct]


# ── ops ──

def op_hello(msg):
    return {"version": VERSION, "os": os_name(), "data": data_dir()}


def op_add(msg):
    acct = str(msg.get("acct") or "").strip()
    host = str(msg.get("host") or "").strip()
    email_addr = str(msg.get("email") or "").strip()
    user = str(msg.get("user") or email_addr).strip()
    password = str(msg.get("password") or "").strip()
    plain = bool(msg.get("plain"))
    try:
        port = int(msg.get("port") or 993)
    except (TypeError, ValueError):
        raise Fail("The port has to be a number.")
    if not acct or not host or not user or not password:
        raise Fail("The account, server, login and password are all needed.")
    worked = None
    last = None
    for cand in login_candidates(user, email_addr):
        conn = connect(host, port, plain)
        try:
            login(conn, cand, password)
            worked = cand
            break
        except Fail as e:
            last = e
            if not e.auth:
                raise
        finally:
            close(conn)
    if worked is None:
        raise last
    vault().set(acct, password)
    rec = {"host": host, "port": port, "user": worked}
    if plain:
        rec["plain"] = True
    save_account(acct, rec)
    a = account(acct)
    with a.lock:
        a.drop()
    return {"user": worked}


def op_remove(msg):
    acct = str(msg.get("acct") or "")
    with _accts_lock:
        a = _accts.pop(acct, None)
    if a:
        with a.lock:
            a.drop()
    vault().delete(acct)
    save_account(acct, None)
    return {}


def op_poll(msg):
    acct = str(msg.get("acct") or "")
    now = int(time.time() * 1000)
    try:
        since = int(msg.get("since") or (now - LOOK_BACK_MS))
    except (TypeError, ValueError):
        since = now - LOOK_BACK_MS
    try:
        limit = max(1, min(50, int(msg.get("limit") or 20)))
    except (TypeError, ValueError):
        limit = 20
    skip = set(str(k) for k in (msg.get("skip") or []))
    return {"messages": account(acct).poll(since, limit, skip)}


OPS = {"hello": op_hello, "add": op_add, "remove": op_remove, "poll": op_poll}


def handle(msg):
    """One request to one answer. Never raises."""
    rid = msg.get("id") if isinstance(msg, dict) else None
    try:
        if not isinstance(msg, dict):
            raise Fail("Not a request.")
        fn = OPS.get(msg.get("op"))
        if not fn:
            raise Fail("Unknown request %r." % msg.get("op"))
        res = fn(msg)
        res.update({"re": rid, "ok": True})
        return res
    except Fail as e:
        ans = {"re": rid, "error": str(e)}
        if e.auth:
            ans["auth"] = True
        if e.code:
            ans["code"] = e.code
        if e.code not in (None, "login", "unknown"):
            log("%s: %s" % (msg.get("op") if isinstance(msg, dict) else "?", e))
        return ans
    except Exception as e:  # a bug here, not the server's doing
        log("bug in %s: %s: %s" % (msg.get("op") if isinstance(msg, dict) else "?", type(e).__name__, e))
        return {"re": rid, "error": "The helper hit a problem (%s). helper.log in %s has the details." % (type(e).__name__, data_dir())}


# ── native messaging ──

MAX_IN = 1024 * 1024


def read_message(stream):
    """One message from the browser, or None when it has closed the pipe."""
    head = _read_exact(stream, 4)
    if head is None:
        return None
    (n,) = struct.unpack("<I", head)
    if n > MAX_IN:
        raise ValueError("message too large")
    body = _read_exact(stream, n)
    if body is None:
        return None
    return json.loads(body.decode("utf-8"))


def _read_exact(stream, n):
    buf = b""
    while len(buf) < n:
        chunk = stream.read(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


def write_message(stream, obj):
    body = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    stream.write(struct.pack("<I", len(body)) + body)
    stream.flush()


def main():
    if os_name() == "windows":
        import msvcrt
        msvcrt.setmode(0, os.O_BINARY)
        msvcrt.setmode(1, os.O_BINARY)
    stdin = os.fdopen(0, "rb", buffering=0, closefd=False)
    stdout = os.fdopen(1, "wb", buffering=0, closefd=False)
    out_lock = threading.Lock()

    def answer(msg):
        res = handle(msg)
        with out_lock:
            write_message(stdout, res)

    pool = ThreadPoolExecutor(max_workers=4)
    try:
        while True:
            try:
                msg = read_message(stdin)
            except ValueError as e:
                log("bad message: %s" % e)
                break
            if msg is None:
                break
            pool.submit(answer, msg)
    finally:
        pool.shutdown(wait=True)
        with _accts_lock:
            for a in _accts.values():
                a.drop()


if __name__ == "__main__":
    main()
