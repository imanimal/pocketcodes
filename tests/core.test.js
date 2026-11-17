/* PocketCodes: tests for the pure parts. Run: node --test tests/core.test.js
   The extension's scripts are classic IIFEs on globalThis.PC, so a require() is all it takes to load one. */
const test = require("node:test");
const assert = require("node:assert/strict");

// A small in-memory stand-in for the browser's API, in place before util.js reads `browser`.
const mem = {};
const listeners = [];
globalThis.browser = {
  storage: {
    local: {
      async get(k) {
        const keys = Array.isArray(k) ? k : typeof k === "string" ? [k] : Object.keys(mem);
        const r = {};
        for (const key of keys) if (key in mem) r[key] = JSON.parse(JSON.stringify(mem[key]));
        return r;
      },
      async set(o) { for (const k in o) mem[k] = JSON.parse(JSON.stringify(o[k])); },
      async remove(keys) { for (const k of [].concat(keys)) delete mem[k]; },
    },
  },
  action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} },
  notifications: { create(id, o) { listeners.push({ id, o }); } },
  runtime: { getURL: (p) => "ext://" + p },
  identity: { getRedirectURL: () => "https://example.invalid/cb/" },
};
require("../src/lib/util.js");
require("../src/lib/codes.js");
const { codes } = globalThis.PC;

const find = (subject, text) => codes.find({ subject, text });
const code = (subject, text) => (find(subject, text) || {}).code || null;

test("Google's G- prefix", () => {
  assert.equal(code("G-482913 is your Google verification code", "Don't share this code with anyone."), "482913");
  assert.equal(code("Your Google verification code", "G-123456 is your Google verification code. It expires soon."), "123456");
});

test("sentences with a code word", () => {
  assert.equal(code("Apple ID Code", "Your Apple ID Code is: 635 841. Don't share it with anyone."), "635841");
  assert.equal(code("Your verification code", "Your verification code is 482913."), "482913");
  assert.equal(code("Security code", "Use 7391028 as your Microsoft account security code."), "7391028");
  assert.equal(code("Sign in to Discord", "Your login code is 12-34-56"), null, "three pairs are not a grouping we read");
  assert.equal(code("123456 is your Instagram code", "Don't share it."), "123456");
  assert.equal(code("Your Amazon OTP", "123456 is your Amazon OTP. Do not share it with anyone."), "123456");
  assert.equal(code("Confirm your sign-in", "Enter this code to finish signing in:\n\n4829\n\nIt works for ten minutes."), "4829");
});

test("grouped codes are joined", () => {
  assert.equal(code("Your code", "Your code is 123 456"), "123456");
  assert.equal(code("Your code", "Your code is 123-456"), "123456");
  assert.equal(code("Your code", "Your passcode: 1234-5678"), "12345678");
});

test("mixed letters and digits (Steam Guard style)", () => {
  assert.equal(code("Your Steam account: Access from new computer", "Here is the Steam Guard code you need to login to account gaucho:\n\nK7P4Q\n\nThis email was generated because of a login attempt."), "K7P4Q");
  assert.equal(code("Login code", "Your code:\nHVNWR\nIt expires soon."), "HVNWR");
});

test("the quiet cases give nothing", () => {
  assert.equal(find("Your order has shipped", "Order #123456 shipped on Nov 2, 2026. Track at https://example.com/t/987654321."), null, "no code word");
  assert.equal(find("Weekly digest", "You have 12345 points and 4829 followers."), null, "no code word");
  assert.equal(find("Invoice", "Your invoice 20261102 totals $1234.56. Reference code INV-2026."), null, "money, a long number, no real code");
  assert.equal(find("Sale", "Use code SAVE20 at checkout for 20% off your order."), null, "promo codes are not login codes");
  assert.equal(find("Welcome", "Your account number is 123456."), null, "an account number is not a code");
  assert.equal(find("Security notice", "Copyright 2026 Example Inc. Security team."), null);
});

test("lookalike numbers are skipped when the real code is there", () => {
  const msg = "Your verification code is 482913. It expires in 3600 seconds. Questions? Call 805-555-1234. © 2026 Example";
  assert.equal(code("Verify", msg), "482913");
  assert.equal(code("Verify", "Order 556677 confirmed. Your verification code is 482913."), "482913");
  assert.equal(code("Verify", "This code is valid for 3600 seconds."), null, "a duration is not a code");
  assert.equal(code("Code", "Your code expires in 10 minutes. Your code: 905511"), "905511");
});

test("alternatives come back behind the best", () => {
  const list = codes.all({ subject: "Your code", text: "Your code is 482913. Your backup code is 117733." });
  assert.equal(list[0].code, "482913");
  assert.ok(list.some((c) => c.code === "117733"));
});

test("HTML mail becomes text with its line breaks", () => {
  const html = `<html><head><style>.a{color:red}</style><title>Verify</title></head><body>
    <p>Hi&nbsp;there,</p><p>Your verification code is</p><div style="font-size:32px"><b>482&#8203;913</b></div>
    <p>Sent to <a href="mailto:me@example.com">me@example.com</a> &amp; friends &#169; 2026</p></body></html>`;
  const text = codes.htmlToText(html);
  assert.ok(!/color:red/.test(text) && !/<b>/.test(text));
  assert.match(text, /Hi there,/);
  assert.equal(code("Verify", text), "482913");
});

test("invisible characters and links don't hide or fake a code", () => {
  const z = String.fromCharCode(0x200b);
  assert.equal(code("Code", `Your co${z}de is 482${z}913 https://example.com/verify?t=999999`), "482913");
});

const link = (subject, text, links) => (codes.link({ subject, text, links }) || {}).url || null;

test("a verification link is read from plain text by the words before it", () => {
  const msg = "Hello,\n\nYou are signing in from a new location. To verify this sign-in, click the link below:\n\n"
    + "https://forum.example.com/login.php?do=verifylocation&u=123&k=9f8a7b6c5d4e3f2a1b0c\n\n"
    + "If you did not try to sign in, change your password:\n\nhttps://forum.example.com/profile.php?do=editpassword\n";
  const hit = codes.link({ subject: "Verify your new sign-in location", text: msg });
  assert.equal(hit.url, "https://forum.example.com/login.php?do=verifylocation&u=123&k=9f8a7b6c5d4e3f2a1b0c");
  assert.equal(hit.host, "forum.example.com");
  assert.equal(link("Please confirm", "Please confirm your email address by clicking the link below:\nhttps://u1234.ct.mailer.example/ls/click?upn=AAAAAAAAAAAAAAAAAAAAAAAAAAAA."),
    "https://u1234.ct.mailer.example/ls/click?upn=AAAAAAAAAAAAAAAAAAAAAAAAAAAA", "a tracking address, and the full stop after it isn't part of it");
  assert.equal(link("Sign in to Example", "Click the link below to sign in to Example. This link expires in 10 minutes.\nhttps://app.example.com/auth/magic?token=eyJhbGciOiJIUzI1NiJ9abcdef"),
    "https://app.example.com/auth/magic?token=eyJhbGciOiJIUzI1NiJ9abcdef", "a sign-in link");
});

test("a verification link is read from an HTML mail's own links", () => {
  const html = `<p>Confirm your email address to finish.</p><a href="https://example.com/">Example</a>
    <a class="btn" href="https://click.mail.example.com/ls/click?upn=u001.abcdefghijklmnopqrstuvwxyz&amp;x=1"><b>Verify</b> email address</a>
    <a href='https://example.com/unsubscribe?u=1'>Unsubscribe</a> <a href="mailto:help@example.com">Write to us</a>
    <a href=https://example.com/app><img alt="Open the app" src="a.png"></a>`;
  const links = codes.anchors(html);
  assert.deepEqual(links.map((l) => l.label), ["Example", "Verify email address", "Unsubscribe", "Open the app"], "web links only, with their words or a picture's alt text");
  assert.equal(links[1].url, "https://click.mail.example.com/ls/click?upn=u001.abcdefghijklmnopqrstuvwxyz&x=1");
  assert.equal(link("Confirm your email", codes.htmlToText(html), links), links[1].url);
});

test("mail that only looks like it has a verification link gives none", () => {
  assert.equal(link("Order confirmation", "Thanks for your order.\nView your order: https://shop.example.com/orders/123", [{ url: "https://shop.example.com/orders/123", label: "View your order" }]), null, "an order confirmation");
  assert.equal(link("New sign-in to your account", "We noticed a new sign-in. If this wasn’t you, secure your account: https://accounts.example.com/secure?token=aaaaaaaaaaaaaaaaaaaaaaaaa"), null, "the link that undoes it");
  assert.equal(link("Reset your password", "Click to reset your password: https://example.com/reset?token=abcabcabcabcabcabcabcabc"), null, "a password reset");
  assert.equal(link("Confirm your seat!", "Confirm your seat! Click here: https://events.example.com/rsvp?id=12"), null, "nothing about the address says verify");
  assert.equal(link("Welcome", "Your account has been verified. Log in: https://example.com/login"), null, "already verified");
  assert.equal(link("Weekly digest", "Read more: https://example.com/verify-your-sources-article"), null, "the word is only in the address");
  assert.equal(link("Verify your email", "Verify your email", [{ url: "https://www.facebook.com/example", label: "Verify us on Facebook" }, { url: "javascript:alert(1)", label: "Verify" }]), null, "social and non-web links");
  assert.equal(link("Your code", "Your verification code is 482913."), null);
});

test("a sender's mail domain, and whose a host is", () => {
  assert.equal(codes.domain('"Example" <no-reply@mail.example.com>'), "mail.example.com");
  assert.equal(codes.domain("no-reply@Example.com"), "example.com");
  assert.equal(codes.domain("Example"), "");
  const { org, linkFor } = globalThis.PC;
  assert.equal(org("mail.example.com"), "example.com");
  assert.equal(org("forum.example.co.uk"), "example.co.uk");
  assert.equal(org("127.0.0.1"), "127.0.0.1");
  assert.ok(linkFor({ host: "forum.example.com", dom: "mailer.example" }, "www.example.com"), "the link goes to this site");
  assert.ok(linkFor({ host: "click.mailer.example", dom: "mail.example.com" }, "example.com"), "this site's mail sent it");
  assert.ok(!linkFor({ host: "example.com.evil.example", dom: "evil.example" }, "example.com"));
  assert.ok(!linkFor({ host: "", dom: "" }, ""));
});

test("the inbox keeps a code as a code, a link mail as a link, and never a link from a text", async () => {
  require("../src/lib/texts.js");
  require("../src/lib/inbox.js");
  const { PC } = globalThis;
  const at = Date.now();
  const verify = "To verify this sign-in, click the link below:\nhttps://forum.example.com/verify?k=9f8a7b6c5d4e3f2a1b0c9f8a";
  PC.fake = { fetchRecent: async () => [
    { key: "f:1", from: '"Example Forum" <no-reply@mail.example.com>', subject: "Verify your new sign-in", text: verify, at },
    { key: "f:2", from: "Example <no-reply@example.com>", subject: "Your code", text: "Your verification code is 482913. Or click to verify: https://example.com/verify?token=aaaaaaaaaaaaaaaaaaaaaaaa", at },
    { key: "f:3", from: "+15550100", subject: "PocketCodes text", text: verify, at },
  ] };
  const found = await PC.inbox.readOne({ id: "fake:you@example.com", kind: "fake", email: "you@example.com" });
  assert.deepEqual(found.map((f) => [f.id, f.code, f.link || "", f.host || "", f.dom || ""]), [
    ["f:1", "", "https://forum.example.com/verify?k=9f8a7b6c5d4e3f2a1b0c9f8a", "forum.example.com", "mail.example.com"],
    ["f:2", "482913", "", "", ""],
  ]);
  // the Fill key's "newest code" is never a link
  await PC.inbox.keep(found);
  assert.equal((await PC.inbox.newest()).code, "482913");
});

test("an authenticator's otpauth link and a bare key are both read", () => {
  const a = codes.otpauth("otpauth://totp/GitHub:octo%20cat?secret=JBSW%20Y3DP-EHPK3PXP&issuer=GitHub&digits=8&period=60&algorithm=sha256");
  assert.deepEqual(a, { secret: "JBSWY3DPEHPK3PXP", issuer: "GitHub", name: "octo cat", digits: 8, period: 60, algo: "SHA256" });
  const b = codes.otpauth("otpauth://totp/you@example.com?secret=JBSWY3DPEHPK3PXP");
  assert.equal(b.issuer, "");
  assert.equal(b.name, "you@example.com");
  assert.equal(b.digits, 6);
  assert.equal(codes.otpauth("jbsw y3dp ehpk 3pxp").secret, "JBSWY3DPEHPK3PXP");
  assert.equal(codes.otpauth("otpauth://hotp/X?secret=JBSWY3DPEHPK3PXP&counter=1"), null, "counter codes aren't supported");
  assert.equal(codes.otpauth("not a key"), null);
  assert.equal(codes.otpauth("123456"), null);
});

test("Duo's activation is read from the QR code's text, the QR image's link or the emailed link", () => {
  const want = { host: "api-b0cd41ef.duosecurity.com", code: "g2FnOKPFmFNBoHXvPt7u" };
  const qr = "g2FnOKPFmFNBoHXvPt7u-YXBpLWIwY2Q0MWVmLmR1b3NlY3VyaXR5LmNvbQ";
  assert.deepEqual(codes.duo(qr), want);
  assert.deepEqual(codes.duo(" duo://" + qr + "\n"), want);
  assert.deepEqual(codes.duo("https://api-b0cd41ef.duosecurity.com/frame/qr?value=duo%3A%2F%2F" + qr), want);
  assert.deepEqual(codes.duo("https://api-b0cd41ef.duosecurity.com/frame/qr?value=" + encodeURIComponent("https://m-b0cd41ef.duosecurity.com/activate/g2FnOKPFmFNBoHXvPt7u")), want);
  assert.deepEqual(codes.duo("https://m-b0cd41ef.duosecurity.com/activate/g2FnOKPFmFNBoHXvPt7u"), want);
  assert.deepEqual(codes.duo("https://m-1a2b3c4d.duofederal.com/android/ABCDEFGHIJ1234567890"), { host: "api-1a2b3c4d.duofederal.com", code: "ABCDEFGHIJ1234567890" });
  // the host comes from the code itself, and it has to be one of Duo's
  assert.equal(codes.duo("g2FnOKPFmFNBoHXvPt7u-" + btoa("api-1.example.com").replace(/=+$/, "")), null);
  assert.equal(codes.duo("https://m-b0cd41ef.example.com/activate/g2FnOKPFmFNBoHXvPt7u"), null);
  assert.equal(codes.duo("https://m-b0cd41ef.duosecurity.com/activate/"), null);
  assert.equal(codes.duo("JBSWY3DPEHPK3PXP"), null, "an ordinary authenticator key isn't Duo's");
  assert.equal(codes.duo("482913"), null);
  assert.equal(codes.duo(""), null);
});

test("sites are bare host names, and subdomains count as the site", () => {
  assert.equal(codes.site("https://www.GitHub.com/login?x=1"), "github.com");
  assert.equal(codes.site("accounts.google.com"), "accounts.google.com");
  assert.equal(codes.site("GitHub"), "");
  assert.ok(codes.sameSite("accounts.google.com", "google.com"));
  assert.ok(codes.sameSite("github.com", "github.com"));
  assert.ok(!codes.sameSite("notgithub.com", "github.com"));
  assert.ok(!codes.sameSite("github.com", ""));
});
