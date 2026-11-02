"""Tests for the IMAP helper and its installer. Run: python -m unittest discover -s tests -p "test_*.py"

A fake IMAP server on a local socket stands in for iCloud: it speaks just enough IMAP4rev1 for imaplib (LOGIN,
CAPABILITY, EXAMINE, UID SEARCH, UID FETCH, NOOP, LOGOUT) and records every command, so the tests can check the
helper only ever reads. All addresses are made up."""

import io
import json
import os
import re
import socket
import socketserver
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "host"))
import install_host  # noqa: E402
import authskip_host as host  # noqa: E402

NOW = int(time.time() * 1000)
MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()


def idate(ms):
    t = time.gmtime(ms / 1000)
    return "%02d-%s-%04d %02d:%02d:%02d +0000" % (t.tm_mday, MONTHS[t.tm_mon - 1], t.tm_year, t.tm_hour, t.tm_min, t.tm_sec)


def plain_mail(frm, subject, body):
    return ("From: %s\r\nTo: someone@example.com\r\nSubject: %s\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n%s\r\n" % (frm, subject, body)).encode("utf-8")


def html_mail(frm, subject, html):
    return ("From: %s\r\nSubject: %s\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n%s\r\n" % (frm, subject, html)).encode("utf-8")


ARG = re.compile(r'"((?:[^"\\]|\\.)*)"|(\S+)')


class FakeImap(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, logins, mail, uidvalidity=777):
        super().__init__(("127.0.0.1", 0), Handler)
        self.logins = logins            # {user: password}
        self.mail = mail                # [(uid, ms, raw)]
        self.uidvalidity = uidvalidity
        self.commands = []
        self.socks = []
        threading.Thread(target=self.serve_forever, daemon=True).start()

    @property
    def port(self):
        return self.server_address[1]

    def drop_clients(self):
        for s in self.socks:
            try:
                s.shutdown(socket.SHUT_RDWR)
                s.close()
            except OSError:
                pass
        self.socks = []

    def stop(self):
        self.drop_clients()
        self.shutdown()
        self.server_close()


class Handler(socketserver.StreamRequestHandler):
    def send(self, line):
        self.wfile.write(line if isinstance(line, bytes) else line.encode("utf-8"))

    def handle(self):
        srv = self.server
        srv.socks.append(self.request)
        self.send("* OK fake IMAP ready\r\n")
        authed = False
        while True:
            try:
                line = self.rfile.readline()
            except OSError:
                return
            if not line:
                return
            text = line.decode("utf-8").rstrip("\r\n")
            tag, _, rest = text.partition(" ")
            parts = [a or b for a, b in ARG.findall(rest)]
            cmd = parts[0].upper() if parts else ""
            if cmd == "UID" and len(parts) > 1:
                cmd = "UID " + parts[1].upper()
            srv.commands.append(cmd if cmd != "LOGIN" else "LOGIN " + parts[1])
            srv.commands_raw = getattr(srv, "commands_raw", []) + [rest if cmd != "LOGIN" else "LOGIN"]
            if cmd == "CAPABILITY":
                self.send("* CAPABILITY IMAP4rev1\r\n%s OK done\r\n" % tag)
            elif cmd == "LOGIN":
                user, pw = parts[1], parts[2].replace('\\"', '"').replace("\\\\", "\\")
                if srv.logins.get(user) == pw:
                    authed = True
                    self.send("%s OK logged in\r\n" % tag)
                else:
                    self.send("%s NO [AUTHENTICATIONFAILED] Authentication failed.\r\n" % tag)
            elif cmd == "NOOP":
                self.send("%s OK noop\r\n" % tag)
            elif cmd == "LOGOUT":
                self.send("* BYE\r\n%s OK bye\r\n" % tag)
                return
            elif not authed:
                self.send("%s BAD log in first\r\n" % tag)
            elif cmd == "EXAMINE":
                self.send("* %d EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY %d] ok\r\n%s OK [READ-ONLY] examined\r\n" % (len(srv.mail), srv.uidvalidity, tag))
            elif cmd == "UID SEARCH":
                self.send("* SEARCH %s\r\n%s OK searched\r\n" % (" ".join(str(u) for u, _, _ in srv.mail), tag))
            elif cmd == "UID FETCH":
                want = {int(x) for x in parts[2].split(",")}
                for seq, (uid, ms, raw) in enumerate(srv.mail, 1):
                    if uid in want:
                        self.send(('* %d FETCH (UID %d INTERNALDATE "%s" BODY[]<0> {%d}\r\n' % (seq, uid, idate(ms), len(raw))).encode("ascii") + raw + b")\r\n")
                self.send("%s OK fetched\r\n" % tag)
            else:
                self.send("%s BAD not here\r\n" % tag)


class HelperCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["AUTHSKIP_DATA"] = self.tmp.name
        host._vault = None
        host._accts.clear()
        self.servers = []

    def tearDown(self):
        for a in list(host._accts.values()):
            a.drop()
        host._accts.clear()
        for s in self.servers:
            s.stop()
        os.environ.pop("AUTHSKIP_DATA", None)
        self.tmp.cleanup()

    def server(self, logins, mail):
        s = FakeImap(logins, mail)
        self.servers.append(s)
        return s

    def add(self, srv, acct="imap:sam@example.com", email="sam@example.com", user=None, password="pw-1"):
        return host.handle({"id": 1, "op": "add", "acct": acct, "host": "127.0.0.1", "port": srv.port,
                            "user": user or email, "email": email, "password": password, "plain": True})


class TestOps(HelperCase):
    def test_hello(self):
        r = host.handle({"id": 7, "op": "hello"})
        self.assertEqual(r["re"], 7)
        self.assertTrue(r["ok"])
        self.assertEqual(r["version"], host.VERSION)
        self.assertIn(r["os"], ("windows", "macos", "linux"))
        self.assertEqual(r["data"], self.tmp.name)

    def test_unknown_op(self):
        r = host.handle({"id": 2, "op": "send"})
        self.assertIn("error", r)
        self.assertNotIn("ok", r)

    def test_add_keeps_the_password_in_the_vault_only(self):
        srv = self.server({"sam@example.com": 'p"w\\1'}, [])
        r = self.add(srv, password='p"w\\1')
        self.assertTrue(r.get("ok"), r)
        self.assertEqual(r["user"], "sam@example.com")
        self.assertEqual(host.vault().get("imap:sam@example.com"), 'p"w\\1')
        with open(os.path.join(self.tmp.name, "accounts.json"), encoding="utf-8") as f:
            saved = f.read()
        self.assertNotIn("p\\\"w", saved)
        self.assertEqual(json.loads(saved)["imap:sam@example.com"]["user"], "sam@example.com")

    def test_wrong_password_is_an_auth_error_and_saves_nothing(self):
        srv = self.server({"sam@example.com": "right"}, [])
        r = self.add(srv, password="wrong")
        self.assertTrue(r.get("auth"))
        self.assertEqual(r.get("code"), "login")
        self.assertIsNone(host.vault().get("imap:sam@example.com"))
        self.assertEqual(host.load_accounts(), {})

    def test_icloud_retries_with_the_name_before_the_at(self):
        srv = self.server({"sam": "abcd-efgh-ijkl-mnop"}, [])
        r = self.add(srv, acct="imap:sam@icloud.com", email="sam@icloud.com", password="abcd-efgh-ijkl-mnop")
        self.assertTrue(r.get("ok"), r)
        self.assertEqual(r["user"], "sam")
        self.assertEqual(host.load_accounts()["imap:sam@icloud.com"]["user"], "sam")
        self.assertEqual([c for c in srv.commands if c.startswith("LOGIN")], ["LOGIN sam@icloud.com", "LOGIN sam"])

    def test_other_domains_dont_retry(self):
        srv = self.server({"sam": "pw"}, [])
        r = self.add(srv, password="pw")
        self.assertTrue(r.get("auth"))
        self.assertEqual([c for c in srv.commands if c.startswith("LOGIN")], ["LOGIN sam@example.com"])

    def test_plain_imap_only_to_this_computer(self):
        r = host.handle({"id": 1, "op": "add", "acct": "imap:a@example.com", "host": "imap.example.com", "port": 143,
                         "user": "a@example.com", "email": "a@example.com", "password": "x", "plain": True})
        self.assertEqual(r.get("code"), "tls")

    def test_poll_reads_recent_mail_without_changing_it(self):
        mail = [
            (3, NOW - 2 * 3600 * 1000, plain_mail("Old <old@example.com>", "Your code", "Your code is 111111")),
            (5, NOW - 60000, plain_mail('"Apple" <noreply@example.com>', "Your verification code", "Your verification code is 635841.")),
            (8, NOW - 30000, html_mail("Shop <shop@example.com>", "Sign in", "<p>Your code is</p><b>482=E2=80=8B913</b><style>.x{}</style>")),
        ]
        srv = self.server({"sam@example.com": "pw"}, mail)
        self.assertTrue(self.add(srv, password="pw").get("ok"))
        r = host.handle({"id": 3, "op": "poll", "acct": "imap:sam@example.com", "since": NOW - 30 * 60000, "limit": 20})
        self.assertTrue(r.get("ok"), r)
        msgs = r["messages"]
        self.assertEqual([m["key"] for m in msgs], ["i:imap:sam@example.com:777:8", "i:imap:sam@example.com:777:5"], "newest first, the two-hour-old one left out")
        self.assertEqual(msgs[1]["from"], "Apple <noreply@example.com>")
        self.assertEqual(msgs[1]["subject"], "Your verification code")
        self.assertIn("635841", msgs[1]["text"])
        self.assertIn("Your code is", msgs[0]["text"])
        self.assertNotIn("<b>", msgs[0]["text"])
        self.assertNotIn(".x{}", msgs[0]["text"])
        self.assertTrue(abs(msgs[1]["at"] - (NOW - 60000)) < 2000)

        # read-only: EXAMINE, never SELECT; BODY.PEEK; nothing that changes a mailbox
        self.assertIn("EXAMINE", srv.commands)
        self.assertNotIn("SELECT", srv.commands)
        fetches = [c for c in srv.commands_raw if c.upper().startswith("UID FETCH")]
        self.assertTrue(fetches and all("BODY.PEEK[]<0.30000>" in c for c in fetches), fetches)
        for bad in ("STORE", "UID STORE", "EXPUNGE", "COPY", "UID COPY", "MOVE", "APPEND", "DELETE"):
            self.assertNotIn(bad, srv.commands)

    def test_poll_skips_keys_already_read(self):
        mail = [(5, NOW - 60000, plain_mail("a@example.com", "Code", "Your code is 635841")),
                (6, NOW - 50000, plain_mail("b@example.com", "Code", "Your code is 482913"))]
        srv = self.server({"sam@example.com": "pw"}, mail)
        self.add(srv, password="pw")
        r = host.handle({"id": 4, "op": "poll", "acct": "imap:sam@example.com", "since": NOW - 600000, "skip": ["i:imap:sam@example.com:777:5"]})
        self.assertEqual([m["key"] for m in r["messages"]], ["i:imap:sam@example.com:777:6"])
        self.assertEqual([c.split()[2] for c in srv.commands_raw if c.upper().startswith("UID FETCH")], ["6"])
        before = len(srv.commands_raw)
        r = host.handle({"id": 5, "op": "poll", "acct": "imap:sam@example.com", "since": NOW - 600000,
                         "skip": ["i:imap:sam@example.com:777:5", "i:imap:sam@example.com:777:6"]})
        self.assertEqual(r["messages"], [])
        self.assertFalse(any(c.upper().startswith("UID FETCH") for c in srv.commands_raw[before:]), "nothing new, nothing fetched")

    def test_poll_limit_takes_the_newest(self):
        mail = [(u, NOW - 60000 + u, plain_mail("a@example.com", "n", "Your code is %06d" % u)) for u in range(1, 8)]
        srv = self.server({"sam@example.com": "pw"}, mail)
        self.add(srv, password="pw")
        r = host.handle({"id": 4, "op": "poll", "acct": "imap:sam@example.com", "since": NOW - 600000, "limit": 3})
        self.assertEqual(sorted(int(m["key"].rsplit(":", 1)[1]) for m in r["messages"]), [5, 6, 7])

    def test_poll_keeps_one_connection_and_reconnects_after_a_drop(self):
        srv = self.server({"sam@example.com": "pw"}, [(5, NOW - 60000, plain_mail("a@example.com", "Code", "Your code is 635841"))])
        self.add(srv, password="pw")
        ask = {"id": 6, "op": "poll", "acct": "imap:sam@example.com", "since": NOW - 600000}
        self.assertTrue(host.handle(ask).get("ok"))
        self.assertTrue(host.handle(ask).get("ok"))
        logins = lambda: len([c for c in srv.commands if c.startswith("LOGIN")])
        self.assertEqual(logins(), 2, "one for add, one for the two polls")
        srv.drop_clients()
        r = host.handle(ask)
        self.assertTrue(r.get("ok"), r)
        self.assertEqual(len(r["messages"]), 1)
        self.assertEqual(logins(), 3)

    def test_unknown_account_asks_to_sign_in_again(self):
        r = host.handle({"id": 8, "op": "poll", "acct": "imap:nobody@example.com"})
        self.assertTrue(r.get("auth"))
        self.assertEqual(r.get("code"), "unknown")

    def test_changed_password_on_the_server_is_an_auth_error(self):
        srv = self.server({"sam@example.com": "pw"}, [])
        self.add(srv, password="pw")
        srv.logins["sam@example.com"] = "new"
        srv.drop_clients()
        r = host.handle({"id": 9, "op": "poll", "acct": "imap:sam@example.com"})
        self.assertTrue(r.get("auth"), r)

    def test_remove_forgets_everything(self):
        srv = self.server({"sam@example.com": "pw"}, [])
        self.add(srv, password="pw")
        self.assertTrue(host.handle({"id": 10, "op": "remove", "acct": "imap:sam@example.com"}).get("ok"))
        self.assertIsNone(host.vault().get("imap:sam@example.com"))
        self.assertEqual(host.load_accounts(), {})
        self.assertTrue(host.handle({"id": 11, "op": "poll", "acct": "imap:sam@example.com"}).get("auth"))


class TestParts(HelperCase):
    def test_framing_round_trip(self):
        buf = io.BytesIO()
        host.write_message(buf, {"re": 1, "text": "caf\u00e9 \u2713"})
        raw = buf.getvalue()
        self.assertEqual(struct.unpack("<I", raw[:4])[0], len(raw) - 4)
        self.assertEqual(host.read_message(io.BytesIO(raw)), {"re": 1, "text": "caf\u00e9 \u2713"})
        self.assertIsNone(host.read_message(io.BytesIO(b"")))
        self.assertIsNone(host.read_message(io.BytesIO(raw[:6])), "a cut-off message is the end")
        with self.assertRaises(ValueError):
            host.read_message(io.BytesIO(struct.pack("<I", 5 * 1024 * 1024)))

    def test_the_helper_runs_as_the_browser_starts_it(self):
        env = dict(os.environ, AUTHSKIP_DATA=self.tmp.name)
        msg = json.dumps({"id": 1, "op": "hello"}).encode("utf-8")
        p = subprocess.run([sys.executable, "-I", "-B", os.path.join(ROOT, "host", "authskip_host.py"), "chrome-extension://x/"],
                           input=struct.pack("<I", len(msg)) + msg, capture_output=True, env=env, timeout=30)
        self.assertEqual(p.returncode, 0, p.stderr)
        n = struct.unpack("<I", p.stdout[:4])[0]
        r = json.loads(p.stdout[4:4 + n])
        self.assertEqual((r["re"], r["ok"], r["version"]), (1, True, host.VERSION))
        self.assertEqual(len(p.stdout), 4 + n, "nothing else on stdout")

    def test_vault_round_trip_on_this_os(self):
        if host.os_name() != "linux":
            self.skipTest("the DPAPI and Keychain vaults need their own OS")
        v = host.vault()
        v.set("imap:a@example.com", "s3cret \u00e9")
        self.assertEqual(v.get("imap:a@example.com"), "s3cret \u00e9")
        self.assertIsNone(v.get("imap:b@example.com"))
        path = os.path.join(self.tmp.name, "vault.json")
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
        v.delete("imap:a@example.com")
        self.assertIsNone(v.get("imap:a@example.com"))

    def test_internaldate(self):
        self.assertEqual(host.internaldate_ms(b'INTERNALDATE "02-Nov-2026 10:15:00 +0000"'), 1793614500000)
        self.assertEqual(host.internaldate_ms(b'INTERNALDATE " 2-Nov-2026 02:15:00 -0800"'), 1793614500000)
        self.assertIsNone(host.internaldate_ms(b"UID 5"))

    def test_search_date_is_a_day_early(self):
        self.assertEqual(host.imap_date(1793614500000), "01-Nov-2026")

    def test_html_to_text(self):
        t = host.html_to_text("<html><head><title>x</title></head><body><p>Hi&nbsp;there</p><div>Code: <b>482913</b></div><!-- 999999 --></body></html>")
        self.assertIn("Hi\u00a0there", t)
        self.assertIn("Code: 482913", t)
        self.assertNotIn("999999", t)
        self.assertNotIn("x", t.split("Hi")[0])

    def test_multipart_prefers_plain(self):
        raw = (b"From: a@example.com\r\nSubject: s\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary=XX\r\n\r\n"
               b"--XX\r\nContent-Type: text/plain\r\n\r\nPlain code 111222\r\n--XX\r\nContent-Type: text/html\r\n\r\n<p>Html code 333444</p>\r\n--XX--\r\n")
        m = host.parse_message(raw)
        self.assertIn("111222", m["text"])
        self.assertNotIn("333444", m["text"])

    def test_cut_off_message_still_parses(self):
        raw = plain_mail("a@example.com", "Code", "Your code is 482913. " + "x" * 50000)[:30000]
        m = host.parse_message(raw)
        self.assertIn("482913", m["text"])
        self.assertLessEqual(len(m["text"]), host.TEXT_CAP)

    def test_fetch_parts_with_uid_after_the_literal(self):
        data = [(b'1 (INTERNALDATE "02-Nov-2026 10:15:00 +0000" BODY[]<0> {3}', b"abc"), b" UID 42)"]
        [(uid, meta, raw)] = host.fetch_parts(data)
        self.assertEqual((uid, raw, host.internaldate_ms(meta)), (42, b"abc", 1793614500000))


class TestInstaller(unittest.TestCase):
    def test_id_from_the_manifest_key(self):
        self.assertEqual(install_host.pinned_chrome_id(), "kammpeiopjjhipmdggclkefddnlagnpk")

    def test_manifests(self):
        c = install_host.chrome_manifest("/x/run.sh", ["kammpeiopjjhipmdggclkefddnlagnpk", "abcdefghijklmnopabcdefghijklmnop"])
        self.assertEqual(c["name"], "io.github.imanimal.authskip")
        self.assertEqual(c["type"], "stdio")
        self.assertEqual(c["allowed_origins"], ["chrome-extension://kammpeiopjjhipmdggclkefddnlagnpk/", "chrome-extension://abcdefghijklmnopabcdefghijklmnop/"])
        self.assertNotIn("allowed_extensions", c)
        f = install_host.firefox_manifest("/x/run.sh")
        self.assertEqual(f["allowed_extensions"], ["authskip@imanimal.github.io"])
        self.assertNotIn("allowed_origins", f)

    def test_name_matches_the_extension(self):
        with open(os.path.join(ROOT, "src", "lib", "util.js"), encoding="utf-8") as fh:
            self.assertIn('AS.HOST = "%s"' % install_host.NAME, fh.read())
        with open(os.path.join(ROOT, "manifest.json"), encoding="utf-8") as fh:
            self.assertEqual(json.load(fh)["browser_specific_settings"]["gecko"]["id"], install_host.FIREFOX_ID)

    def test_targets(self):
        win = install_host.targets("windows", "C:\\Users\\sam")
        self.assertIn(("Chrome", "chrome", "Software\\Google\\Chrome\\NativeMessagingHosts\\io.github.imanimal.authskip", "Software\\Google\\Chrome"), win)
        self.assertIn(("Firefox", "firefox", "Software\\Mozilla\\NativeMessagingHosts\\io.github.imanimal.authskip", "Software\\Mozilla"), win)
        mac = dict((b, w) for b, _, w, _ in install_host.targets("macos", "/Users/sam"))
        self.assertEqual(mac["Chrome"], "/Users/sam/Library/Application Support/Google/Chrome/NativeMessagingHosts/io.github.imanimal.authskip.json")
        self.assertEqual(mac["Firefox"], "/Users/sam/Library/Application Support/Mozilla/NativeMessagingHosts/io.github.imanimal.authskip.json")
        lin = dict((b, w) for b, _, w, _ in install_host.targets("linux", "/home/sam"))
        self.assertEqual(lin["Chrome"], "/home/sam/.config/google-chrome/NativeMessagingHosts/io.github.imanimal.authskip.json")
        self.assertEqual(lin["Firefox"], "/home/sam/.mozilla/native-messaging-hosts/io.github.imanimal.authskip.json")

    def test_launchers(self):
        self.assertEqual(install_host.launcher_text("windows", "C:\\Python313\\python.exe", "C:\\d\\authskip_host.py"),
                         '@echo off\r\n"C:\\Python313\\python.exe" -I -B "C:\\d\\authskip_host.py" %*\r\n')
        self.assertEqual(install_host.launcher_text("macos", "/usr/bin/python3", "/Users/sam/Library/Application Support/AuthSkip/host/authskip_host.py"),
                         "#!/bin/sh\nexec /usr/bin/python3 -I -B '/Users/sam/Library/Application Support/AuthSkip/host/authskip_host.py' \"$@\"\n")

    def test_install_and_uninstall_here(self):
        if host.os_name() != "linux":
            self.skipTest("writes into this user's browser folders")
        with tempfile.TemporaryDirectory() as home, tempfile.TemporaryDirectory() as data:
            old = dict(os.environ)
            os.environ.update(HOME=home, AUTHSKIP_DATA=data)
            try:
                os.makedirs(os.path.join(home, ".config", "chromium"))
                with open(os.devnull, "w") as quiet:
                    out, sys.stdout = sys.stdout, quiet
                    try:
                        install_host.main([])
                    finally:
                        sys.stdout = out
                found = {b: w for b, _, w, _ in install_host.targets("linux", home) if os.path.exists(w)}
                self.assertEqual(sorted(found), ["Chrome", "Chromium", "Firefox"], "Edge and Brave aren't there, so they're left alone")
                with open(found["Chromium"], encoding="utf-8") as fh:
                    m = json.load(fh)
                self.assertTrue(os.access(m["path"], os.X_OK))
                self.assertTrue(os.path.exists(os.path.join(data, "host", "authskip_host.py")))
                with open(os.devnull, "w") as quiet:
                    out, sys.stdout = sys.stdout, quiet
                    try:
                        install_host.main(["--uninstall"])
                    finally:
                        sys.stdout = out
                self.assertFalse(any(os.path.exists(w) for _, _, w, _ in install_host.targets("linux", home)))
                self.assertFalse(os.path.exists(os.path.join(data, "host")))
            finally:
                os.environ.clear()
                os.environ.update(old)


if __name__ == "__main__":
    unittest.main()
