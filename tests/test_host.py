"""Tests for the IMAP helper (host/pocketcodes_host.py), with a fake IMAP connection and a throwaway data folder.
Run: python -m unittest discover -s tests -p "test_*.py" """
import imaplib
import io
import os
import shutil
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
