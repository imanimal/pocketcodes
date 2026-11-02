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
