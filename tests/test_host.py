"""Tests for the IMAP helper (host/pocketcodes_host.py), with a fake IMAP connection and a throwaway data folder.
Run: python -m unittest discover -s tests -p "test_*.py" """
import imaplib
import io
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "host"))
import pocketcodes_host as host  # noqa: E402

NOW = int(time.time() * 1000)


def raw_mail(subject, body, html=False, sender="Example <no-reply@example.com>"):
    kind = "text/html" if html else "text/plain"
    return (f"From: {sender}\r\nTo: you@example.com\r\nSubject: {subject}\r\nMIME-Version: 1.0\r\n"
            f"Content-Type: {kind}; charset=utf-8\r\n\r\n{body}\r\n").encode("utf-8")


def internaldate(ms):
    return imaplib.Time2Internaldate(ms / 1000).encode()  # already quoted


class FakeImap:
    """Just enough of imaplib.IMAP4_SSL: one INBOX of (uid, ms, raw) and a log of the commands it was sent."""
    password = "app-pass"
    users = {"you@example.com"}

    def __init__(self, mails):
        self.mails = mails
        self.log = []
        self.readonly = None

    def login(self, user, password):
        self.log.append(("login", user))
        if user not in self.users or password != self.password:
            raise imaplib.IMAP4.error(b"[AUTHENTICATIONFAILED] Authentication failed.")

    def logout(self):
        self.log.append(("logout",))

    def select(self, box, readonly=False):
        self.readonly = readonly
        self.log.append(("select", box, readonly))
        return "OK", [str(len(self.mails)).encode()]

    def response(self, code):
        return code, [b"777"] if code == "UIDVALIDITY" else [None]

    def uid(self, cmd, *args):
        self.log.append(("uid", cmd) + args)
        if cmd == "SEARCH":
            return "OK", [b" ".join(str(u).encode() for u, _, _ in self.mails)]
        if cmd == "FETCH" and args[1] == "(INTERNALDATE)":
            want = set(args[0].split(","))
            return "OK", [f"{i + 1} (UID {u} INTERNALDATE ".encode() + internaldate(ms) + b")"
                          for i, (u, ms, _) in enumerate(self.mails) if str(u) in want]
        if cmd == "FETCH" and args[1] == "(BODY.PEEK[])":
            for i, (u, _, raw) in enumerate(self.mails):
                if str(u) == args[0]:
                    return "OK", [(f"{i + 1} (UID {u} BODY[] {{{len(raw)}}}".encode(), raw), b")"]
            return "OK", [None]
        raise AssertionError(f"unexpected command {cmd}")


class MemoryVault:
    def __init__(self):
        self.d = {}

    def put(self, acct, pw):
        self.d[acct] = pw

    def get(self, acct):
        return self.d.get(acct)

    def drop(self, acct):
        self.d.pop(acct, None)


class HostTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        os.environ["POCKETCODES_DATA"] = self.dir
        self.mails = [
            (10, NOW - 3 * 3600e3, raw_mail("Old", "Your code is 111111")),
            (11, NOW - 5 * 60e3, raw_mail("Your sign-in code", "Your code is 482913")),
            (12, NOW - 60e3, raw_mail("Verify", "<p>Your code:</p><p><b>735201</b></p>", html=True)),
        ]
        self.conns = []

        def opener(host_, port):
            c = FakeImap(self.mails)
            self.conns.append(c)
            return c
        self.vault = MemoryVault()
        self.helper = host.Helper(vault=self.vault, opener=opener)

    def tearDown(self):
        os.environ.pop("POCKETCODES_DATA", None)
        shutil.rmtree(self.dir, ignore_errors=True)

    def add(self, user="you@example.com", password="app-pass", hostname="imap.example.com"):
        return self.helper.handle({"op": "add", "acct": "imap:you@example.com", "host": hostname, "port": 993,
                                   "user": user, "email": "you@example.com", "password": password})

    def test_framing_round_trip(self):
        buf = io.BytesIO()
        host.write_msg(buf, {"id": 1, "op": "hello", "x": "é"})
        buf.seek(0)
        self.assertEqual(host.read_msg(buf), {"id": 1, "op": "hello", "x": "é"})
        self.assertIsNone(host.read_msg(buf))

    def test_serve_answers_each_request(self):
        inp = io.BytesIO()
        host.write_msg(inp, {"id": 7, "op": "hello"})
        host.write_msg(inp, {"id": 8, "op": "nope"})
        inp.seek(0)
        out = io.BytesIO()
        host.serve(inp, out, self.helper)
        out.seek(0)
        answers = {m["re"]: m for m in iter(lambda: host.read_msg(out), None)}
        self.assertTrue(answers[7]["ok"])
        self.assertEqual(answers[7]["version"], host.VERSION)
        self.assertIn("Unknown request", answers[8]["error"])

    def test_add_keeps_password_in_vault_only(self):
        self.assertEqual(self.add(), {"user": "you@example.com"})
        self.assertEqual(self.vault.get("imap:you@example.com"), "app-pass")
        with open(os.path.join(self.dir, "accounts.json"), encoding="utf-8") as f:
            self.assertNotIn("app-pass", f.read())

    def test_wrong_password_is_an_auth_error(self):
        with self.assertRaises(host.Fail) as e:
            self.add(password="wrong")
        self.assertTrue(e.exception.auth)
        self.assertIsNone(self.vault.get("imap:you@example.com"))

    def test_icloud_falls_back_to_the_name_before_the_at(self):
        FakeImap.users = {"you"}
        try:
            self.assertEqual(self.add(hostname="imap.mail.me.com"), {"user": "you"})
        finally:
            FakeImap.users = {"you@example.com"}

    def test_poll_reads_only_recent_mail_without_marking_it(self):
        self.add()
        r = self.helper.handle({"op": "poll", "acct": "imap:you@example.com", "since": NOW - 30 * 60e3, "limit": 20})
        msgs = r["messages"]
        self.assertEqual([m["key"] for m in msgs], ["i:imap:you@example.com:777:12", "i:imap:you@example.com:777:11"])
        self.assertIn("482913", msgs[1]["text"])
        self.assertEqual(msgs[0]["text"], "")
        self.assertIn("735201", msgs[0]["html"])
        c = self.conns[-1]
        self.assertTrue(c.readonly)
        fetched = [e for e in c.log if e[:2] == ("uid", "FETCH")]
        self.assertTrue(all(e[3] in ("(INTERNALDATE)", "(BODY.PEEK[])") for e in fetched))
        self.assertNotIn("10", [e[2] for e in fetched if e[3] == "(BODY.PEEK[])"])

    def test_second_poll_uses_the_cache(self):
        self.add()
        q = {"op": "poll", "acct": "imap:you@example.com", "since": NOW - 30 * 60e3}
        self.helper.handle(q)
        n = sum(1 for e in self.conns[-1].log if e[-1:] == ("(BODY.PEEK[])",))
        self.helper.handle(q)
        self.assertEqual(sum(1 for e in self.conns[-1].log if e[-1:] == ("(BODY.PEEK[])",)), n)

    def test_unknown_account_asks_to_add_again(self):
        with self.assertRaises(host.Fail) as e:
            self.helper.handle({"op": "poll", "acct": "imap:nobody@example.com", "since": NOW})
        self.assertTrue(e.exception.auth)

    def test_remove_forgets_everything(self):
        self.add()
        self.helper.handle({"op": "remove", "acct": "imap:you@example.com"})
        self.assertIsNone(self.vault.get("imap:you@example.com"))
        self.assertEqual(host._load("accounts.json"), {})

    def test_imap_date_is_a_day_early(self):
        ms = time.mktime((2026, 11, 4, 12, 0, 0, 0, 0, -1)) * 1000
        self.assertIn(host.imap_date(ms), ("03-Nov-2026", "02-Nov-2026"))

    # ── authenticator codes ──
    RFC_KEY = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"  # base32 of the RFC 6238 test key "12345678901234567890"

    def test_totp_matches_the_rfc_vectors(self):
        key = host.b32key(self.RFC_KEY)
        for at, want in ((59, "94287082"), (1111111109, "07081804"), (1234567890, "89005924"), (2000000000, "69279037")):
            self.assertEqual(host.totp(key, at, digits=8)[0], want)
        self.assertEqual(host.totp(key, 59)[0], "287082")
        self.assertEqual(host.totp(key, 59)[1], 1, "59 s into a 30 s window leaves 1 s")

    def test_totp_key_is_read_however_it_was_typed(self):
        self.assertEqual(host.b32key("gezd gnbv-gy3t qojq gezd gnbv gy3t qojq"), host.b32key(self.RFC_KEY))
        with self.assertRaises(host.Fail):
            host.b32key("not a key 0189")
        with self.assertRaises(host.Fail):
            host.b32key("GEZDGNBV")  # 5 bytes: too short to be real

    def test_totp_key_stays_in_the_vault_and_only_codes_come_back(self):
        r = self.helper.handle({"op": "totp-add", "acct": "totp:example.com:you", "secret": self.RFC_KEY.lower()})
        self.assertRegex(r["code"], r"^\d{6}$")
        self.assertNotIn(self.RFC_KEY, json.dumps(r))
        self.assertIn(self.RFC_KEY, self.vault.d["totp:example.com:you"])
        again = self.helper.handle({"op": "totp", "acct": "totp:example.com:you"})
        self.assertEqual(again["code"], host.totp(host.b32key(self.RFC_KEY))[0])
        self.assertFalse(os.listdir(self.dir), "nothing about it lands in the data folder")
        self.helper.handle({"op": "remove", "acct": "totp:example.com:you"})
        with self.assertRaises(host.Fail):
            self.helper.handle({"op": "totp", "acct": "totp:example.com:you"})

    def test_totp_add_refuses_odd_settings(self):
        for extra in ({"digits": 4}, {"algo": "MD5"}, {"period": 5}, {"acct": "imap:you@example.com"}):
            with self.assertRaises(host.Fail):
                self.helper.handle(dict({"op": "totp-add", "acct": "totp:x:y", "secret": self.RFC_KEY}, **extra))

    # ── Duo passcodes ──
    DUO_HOST = "api-b0cd41ef.duosecurity.com"
    DUO_ACCT = "duo:api-b0cd41ef.duosecurity.com"
    DUO_SECRET = "1013b66b8c3fa2b9e4cfd6537c66136b"  # what Duo's hotp_secret looks like: 32 hex characters

    def test_hotp_matches_the_rfc_vectors(self):
        want = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"]
        self.assertEqual([host.hotp(b"12345678901234567890", i) for i in range(10)], want)

    def fake_duo(self, answer=None, status=200):
        """Duo's activation endpoint, answering `answer` (an activated device by default); returns what was sent."""
        sent = []

        def post(url, form):
            sent.append((url, form))
            body = answer if answer is not None else {"stat": "OK", "response": {
                "akey": "DAEXAMPLE", "pkey": "DPEXAMPLE", "customer_name": "Example University", "hotp_secret": self.DUO_SECRET}}
            return status, json.dumps(body).encode("utf-8")
        self.helper.post = post
        return sent

    def duo_add(self, **extra):
        return self.helper.handle(dict({"op": "duo-add", "acct": self.DUO_ACCT, "host": self.DUO_HOST, "code": "g2FnOKPFmFNBoHXvPt7u"}, **extra))

    def test_duo_add_activates_a_device_and_keeps_only_the_key(self):
        sent = self.fake_duo()
        r = self.duo_add()
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0][0], f"https://{self.DUO_HOST}/push/v2/activation/g2FnOKPFmFNBoHXvPt7u?customer_protocol=1")
        self.assertNotIn("pubkey", sent[0][1], "no push key: PocketCodes makes passcodes and can never approve a push")
        # the key is hotp_secret's text as bytes, the codes counted from 0
        self.assertEqual(r, {"code": host.hotp(self.DUO_SECRET.encode("ascii"), 0), "counter": 0, "name": "Example University"})
        self.assertNotIn(self.DUO_SECRET, json.dumps(r))
        self.assertIn(self.DUO_SECRET, self.vault.d[self.DUO_ACCT])
        self.assertFalse(os.listdir(self.dir), "nothing about it lands in the data folder")

    def test_duo_code_holds_until_used_then_moves_on(self):
        self.fake_duo()
        first = self.duo_add()
        self.assertEqual(self.helper.handle({"op": "totp", "acct": self.DUO_ACCT}), {"code": first["code"], "counter": 0})
        self.assertEqual(self.helper.handle({"op": "totp", "acct": self.DUO_ACCT})["counter"], 0, "showing a code doesn't use it")
        nxt = self.helper.handle({"op": "hotp-used", "acct": self.DUO_ACCT, "counter": 0})
        self.assertEqual(nxt, {"code": host.hotp(self.DUO_SECRET.encode("ascii"), 1), "counter": 1})
        # the same code reported twice (copied, then filled) moves on once; a count never given out moves nothing
        for counter in (0, 500, None):
            self.assertEqual(self.helper.handle({"op": "hotp-used", "acct": self.DUO_ACCT, "counter": counter})["counter"], 1)
        self.assertEqual(json.loads(self.vault.d[self.DUO_ACCT])["counter"], 1)
        self.helper.handle({"op": "remove", "acct": self.DUO_ACCT})
        with self.assertRaises(host.Fail):
            self.helper.handle({"op": "totp", "acct": self.DUO_ACCT})

    def test_duo_refusal_says_why_and_keeps_nothing(self):
        self.fake_duo({"stat": "FAIL", "code": 40403, "message": "Invalid activation code"}, status=404)
        with self.assertRaises(host.Fail) as e:
            self.duo_add()
        self.assertIn("Invalid activation code", str(e.exception))
        self.fake_duo({"stat": "OK", "response": {"akey": "DAEXAMPLE"}})
        with self.assertRaises(host.Fail):
            self.duo_add()
        self.fake_duo(status=502, answer="")
        with self.assertRaises(host.Fail):
            self.duo_add()
        self.assertEqual(self.vault.d, {})

    def test_duo_add_only_talks_to_duo(self):
        sent = self.fake_duo()
        for extra in ({"host": "api-b0cd41ef.example.com"}, {"host": "evil.com/x?api-1.duosecurity.com"},
                      {"code": "short"}, {"code": "g2FnOKPFmFNBoHXv/../x"}, {"acct": "totp:example.com:you"}):
            with self.assertRaises(host.Fail):
                self.duo_add(**extra)
        self.assertEqual(sent, [])

    def test_hotp_used_leaves_clock_codes_alone(self):
        self.helper.handle({"op": "totp-add", "acct": "totp:example.com:you", "secret": self.RFC_KEY})
        with self.assertRaises(host.Fail):
            self.helper.handle({"op": "hotp-used", "acct": "totp:example.com:you", "counter": 0})

    # ── texts on a Mac ──

    def chat_db(self, rows, seconds=False):
        path = os.path.join(self.dir, "chat.db")
        db = sqlite3.connect(path)
        db.execute("CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT)")
        db.execute("CREATE TABLE message (ROWID INTEGER PRIMARY KEY, text TEXT, attributedBody BLOB, date INTEGER, handle_id INTEGER, is_from_me INTEGER)")
        db.execute("INSERT INTO handle VALUES (1, '+15550100'), (2, '32665')")
        scale = 1 if seconds else 1e9
        for rowid, text, blob, ms, handle, mine in rows:
            db.execute("INSERT INTO message VALUES (?, ?, ?, ?, ?, ?)", (rowid, text, blob, int((ms / 1000 - host.APPLE_EPOCH) * scale), handle, mine))
        db.commit()
        db.close()
        os.environ["POCKETCODES_CHATDB"] = path
        self.addCleanup(os.environ.pop, "POCKETCODES_CHATDB", None)

    @staticmethod
    def archived(text):
        b = text.encode("utf-8")
        size = bytes([len(b)]) if len(b) < 0x80 else b"\x81" + len(b).to_bytes(2, "little")
        return (b"\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00"
                b"\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+" + size + b + b"\x86\x84\x02iI\x01")

    def test_texts_reads_recent_incoming_messages_only(self):
        self.chat_db([
            (1, "Your Example code is 111111", None, NOW - 3 * 3600e3, 2, 0),   # too old
            (2, "Your Example code is 482913", None, NOW - 60e3, 2, 0),
            (3, None, self.archived("G-735201 is your Google verification code."), NOW - 30e3, 1, 0),
            (4, "sent by me: 999999", None, NOW - 10e3, 1, 1),                  # one of mine
        ])
        got = self.helper.handle({"op": "texts", "since": NOW - 1800e3})["messages"]
        self.assertEqual([m["key"] for m in got], ["t:3", "t:2"])
        self.assertEqual(got[0]["text"], "G-735201 is your Google verification code.")
        self.assertEqual(got[1]["from"], "32665")
        self.assertLess(abs(got[1]["at"] - (NOW - 60e3)), 1500)

    def test_texts_long_archived_body_and_old_second_dates(self):
        long = "Your code is 246810. " + "x" * 300
        self.chat_db([(5, "", self.archived(long), NOW - 5e3, 1, 0)], seconds=True)
        got = self.helper.handle({"op": "texts", "since": NOW - 60e3})["messages"]
        self.assertEqual(got[0]["text"], long)

    def test_texts_without_full_disk_access_says_how_to_allow_it(self):
        path = os.path.join(self.dir, "empty.db")
        sqlite3.connect(path).close()  # no tables, as macOS shows a database it won't let us read
        os.environ["POCKETCODES_CHATDB"] = path
        self.addCleanup(os.environ.pop, "POCKETCODES_CHATDB", None)
        with self.assertRaises(host.Fail) as e:
            self.helper.handle({"op": "texts"})
        self.assertEqual(e.exception.code, "no-access")
        self.assertIn("Full Disk Access", str(e.exception))

    @unittest.skipUnless(host.SYSTEM in ("Windows", "Linux"), "the macOS vault is the Keychain")
    def test_real_vault_round_trip(self):
        v = host.Vault()
        v.put("imap:t@example.com", "s3cret")
        self.assertEqual(v.get("imap:t@example.com"), "s3cret")
        with open(os.path.join(self.dir, "secrets.json"), encoding="utf-8") as f:
            text = f.read()
        if host.SYSTEM == "Windows":
            self.assertNotIn("czNjcmV0", text)  # base64 of the plain password: DPAPI must have changed it
        v.drop("imap:t@example.com")
        self.assertIsNone(v.get("imap:t@example.com"))


if __name__ == "__main__":
    unittest.main()
