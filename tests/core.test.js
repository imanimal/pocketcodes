/* AuthSkip: tests for the pure parts. Run: node --test tests/core.test.js
   The extension's scripts are classic IIFEs on globalThis.AS, so a require() is all it takes to load one. */
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
const { codes } = globalThis.AS;

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

// ── providers, the inbox and the helper client ──
require("../src/lib/google.js");
require("../src/lib/microsoft.js");
require("../src/lib/imap.js");
require("../src/lib/inbox.js");
const AS = globalThis.AS;
const b64u = (s) => Buffer.from(s, "utf8").toString("base64url");
const reset = () => { for (const k of Object.keys(mem)) delete mem[k]; listeners.length = 0; };

test("PKCE matches RFC 7636's example", async () => {
  assert.equal(await AS.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  const p = await AS.pkce();
  assert.match(p.verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.equal(p.challenge, await AS.challenge(p.verifier));
});

const gmailMsg = (id, payload, extra) => Object.assign({
  id, internalDate: String(Date.parse("2026-11-02T10:15:00Z")), snippet: "snippet text",
  payload: Object.assign({ headers: [{ name: "From", value: '"Google" <no-reply@accounts.example.com>' }, { name: "Subject", value: "Your code" }] }, payload),
}, extra);

test("Gmail messages: plain, HTML only, and multipart", () => {
  const plain = AS.google.normalize(gmailMsg("a1", { mimeType: "text/plain", body: { data: b64u("Your code is 482913 — café") } }));
  assert.equal(plain.key, "g:a1");
  assert.equal(plain.from, '"Google" <no-reply@accounts.example.com>');
  assert.equal(plain.subject, "Your code");
  assert.equal(plain.at, Date.parse("2026-11-02T10:15:00Z"));
  assert.match(plain.text, /482913/);
  assert.match(plain.text, /caf/, "UTF-8 decoded");

  const html = AS.google.normalize(gmailMsg("a2", { mimeType: "text/html", body: { data: b64u("<p>Your code is</p><b>635841</b><style>.x{}</style>") } }));
  assert.match(html.text, /Your code is/);
  assert.ok(!/<b>|\.x\{\}/.test(html.text));

  const multi = AS.google.normalize(gmailMsg("a3", {
    mimeType: "multipart/mixed", body: { size: 0 },
    parts: [
      { mimeType: "multipart/alternative", parts: [
        { mimeType: "text/plain", body: { data: b64u("Plain 111222") } },
        { mimeType: "text/html", body: { data: b64u("<p>Html 333444</p>") } },
      ] },
      { mimeType: "application/pdf", filename: "a.pdf", body: { attachmentId: "x" } },
    ],
  }));
  assert.match(multi.text, /111222/);
  assert.ok(!/333444/.test(multi.text), "plain wins over HTML");

  const empty = AS.google.normalize(gmailMsg("a4", { mimeType: "multipart/mixed", parts: [] }));
  assert.equal(empty.text, "snippet text", "the snippet when there is no body");
});

test("Graph messages", () => {
  const m = AS.microsoft.normalize({
    id: "AAMk1", subject: "Microsoft account security code", receivedDateTime: "2026-11-02T10:15:00Z",
    from: { emailAddress: { name: "Microsoft account team", address: "account-security-noreply@example.com" } },
    body: { contentType: "html", content: "<p>Security code: <b>7391028</b></p>" }, bodyPreview: "Security code",
  });
  assert.equal(m.key, "m:AAMk1");
  assert.equal(AS.sender(m.from), "Microsoft account team");
  assert.equal(m.at, Date.parse("2026-11-02T10:15:00Z"));
  assert.match(m.text, /Security code: +7391028/);
  const t = AS.microsoft.normalize({ id: "2", body: { contentType: "text", content: "Use 482913" }, receivedDateTime: "2026-11-02T10:15:00Z" });
  assert.equal(t.text, "Use 482913");
  assert.equal(t.from, "");
  assert.equal(AS.microsoft.normalize({ id: "3", bodyPreview: "Your code is 1", receivedDateTime: "x" }).text, "Your code is 1");
});

/** A fake fetch: `routes` maps a URL test to a handler giving [status, json]; every call is logged. */
function fakeFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    for (const [re, fn] of routes) {
      if (re.test(String(url))) {
        const [status, body] = await fn(String(url), opts);
        return { ok: status >= 200 && status < 300, status, json: async () => body };
      }
    }
    return { ok: false, status: 404, json: async () => ({ error: { message: "no route " + url } }) };
  };
  return calls;
}

const G = { id: "google:sam@example.com", kind: "google", email: "sam@example.com" };
async function gmailSetup(tok) {
  reset();
  mem.accounts = [G];
  mem.google = { clientId: "id.example", clientSecret: "secret" };
  mem["tok:" + G.id] = tok || { refresh: "r1", access: "a1", exp: Date.now() + 3600e3 };
}
const now = () => Date.now();
const gmailRoutes = (msgs) => [
  [/\/messages\?/, () => [200, { messages: Object.keys(msgs).map((id) => ({ id })) }]],
  [/\/messages\/([^/?]+)\?format=full/, (u) => { const id = u.match(/\/messages\/([^/?]+)\?/)[1]; return [200, msgs[id]]; }],
];

test("inbox.poll keeps codes, remembers what it read, and doesn't read it twice", async () => {
  await gmailSetup();
  const msgs = {
    m1: gmailMsg("m1", { mimeType: "text/plain", body: { data: b64u("Your verification code is 482913.") } }, { internalDate: String(now() - 60e3) }),
    m2: gmailMsg("m2", { mimeType: "text/plain", body: { data: b64u("Your order has shipped.") } }, { internalDate: String(now() - 50e3) }),
  };
  const calls = fakeFetch(gmailRoutes(msgs));
  const fresh = await AS.inbox.poll({ force: true });
  assert.equal(fresh.length, 1);
  assert.equal(mem.codes.length, 1);
  const c = mem.codes[0];
  assert.deepEqual([c.id, c.acct, c.code, c.from, c.subject, c.used, c.seen], ["g:m1", G.id, "482913", "Google", "Your code", false, false]);
  assert.ok(!("text" in c), "no message text is kept");
  assert.deepEqual(mem["seen:" + G.id], ["g:m1", "g:m2"]);
  assert.equal(mem["st:" + G.id].ok, true);
  assert.equal(listeners.length, 1, "one notification");
  assert.equal(listeners[0].o.title, "Code 482913");
  assert.ok(calls.every((x) => x.opts.headers.Authorization === "Bearer a1"));

  calls.length = 0;
  const again = await AS.inbox.poll({ force: true });
  assert.equal(again.length, 0);
  assert.equal(calls.filter((x) => /format=full/.test(x.url)).length, 0, "messages already read aren't fetched again");
  assert.equal(mem.codes.length, 1);
});

test("the seen list is capped, newest kept", async () => {
  await gmailSetup();
  mem["seen:" + G.id] = Array.from({ length: 300 }, (_, i) => "g:old" + i);
  fakeFetch(gmailRoutes({ n1: gmailMsg("n1", { mimeType: "text/plain", body: { data: b64u("hello") } }, { internalDate: String(now()) }) }));
  await AS.inbox.poll({ force: true });
  const seen = mem["seen:" + G.id];
  assert.equal(seen.length, 300);
  assert.equal(seen[seen.length - 1], "g:n1");
  assert.equal(seen[0], "g:old1");
});

test("a failing check is recorded on the account, not thrown", async () => {
  await gmailSetup();
  fakeFetch([[/\/messages\?/, () => [500, { error: { message: "Backend Error" } }]]]);
  await AS.inbox.poll({ force: true });
  const st = mem["st:" + G.id];
  assert.equal(st.ok, false);
  assert.equal(st.error, "Backend Error");
  assert.equal(st.auth, false);
  assert.equal(mem["seen:" + G.id], undefined);
});

test("an ended Google sign-in asks to sign in again", async () => {
  await gmailSetup({ refresh: "r1", access: "old", exp: Date.now() - 1000 });
  const calls = fakeFetch([[/oauth2\.googleapis\.com\/token/, () => [400, { error: "invalid_grant", error_description: "Token has been expired or revoked." }]]]);
  await AS.inbox.poll({ force: true });
  assert.equal(mem["st:" + G.id].auth, true);
  assert.match(calls[0].opts.body, /grant_type=refresh_token/);
  assert.match(calls[0].opts.body, /refresh_token=r1/);
});

test("an expired access token is refreshed and saved", async () => {
  await gmailSetup({ refresh: "r1", access: "old", exp: Date.now() - 1000 });
  const calls = fakeFetch([[/oauth2\.googleapis\.com\/token/, () => [200, { access_token: "new", expires_in: 3599 }]], ...gmailRoutes({})]);
  await AS.inbox.poll({ force: true });
  assert.equal(mem["st:" + G.id].ok, true);
  assert.equal(mem["tok:" + G.id].access, "new");
  assert.equal(mem["tok:" + G.id].refresh, "r1");
  assert.equal(calls[1].opts.headers.Authorization, "Bearer new");
});

test("a 401 from Gmail retries once with a fresh token", async () => {
  await gmailSetup();
  let n = 0;
  fakeFetch([
    [/oauth2\.googleapis\.com\/token/, () => [200, { access_token: "a2", expires_in: 3599 }]],
    [/\/messages\?/, (u, o) => (o.headers.Authorization === "Bearer a1" ? (n++, [401, { error: { message: "Invalid Credentials" } }]) : [200, {}])],
  ]);
  await AS.inbox.poll({ force: true });
  assert.equal(n, 1);
  assert.equal(mem["st:" + G.id].ok, true);
});

test("Microsoft accounts go through Graph", async () => {
  reset();
  const M = { id: "microsoft:sam@example.com", kind: "microsoft", email: "sam@example.com" };
  mem.accounts = [M];
  mem.microsoft = { clientId: "app.example" };
  mem["tok:" + M.id] = { refresh: "r", access: "a", exp: Date.now() + 3600e3 };
  const calls = fakeFetch([[/graph\.microsoft\.com\/v1\.0\/me\/mailFolders\/inbox\/messages/, () => [200, { value: [
    { id: "X1", subject: "Your single-use code", receivedDateTime: new Date(now() - 30e3).toISOString(), from: { emailAddress: { name: "Microsoft account team", address: "a@example.com" } }, body: { contentType: "text", content: "Your single-use code is: 482913" } },
  ] }]]]);
  await AS.inbox.poll({ force: true });
  assert.equal(mem.codes[0].code, "482913");
  assert.equal(mem.codes[0].id, "m:X1");
  assert.match(decodeURIComponent(calls[0].url), /receivedDateTime ge /);
});

/** A fake native-messaging port. `answer(msg)` gives the helper's reply; `closePort()` drops the port the way the
    browser does when the helper exits, so imap.js opens a fresh one next time. */
let closePort = () => {};
function fakeHelper(answer) {
  closePort();
  const sent = [];
  globalThis.browser.runtime.connectNative = (name) => {
    assert.equal(name, "io.github.imanimal.authskip");
    const on = [], off = [];
    closePort = () => off.forEach((f) => f());
    return {
      onMessage: { addListener: (f) => on.push(f) },
      onDisconnect: { addListener: (f) => off.push(f) },
      postMessage(m) { sent.push(m); setTimeout(() => on.forEach((f) => f(Object.assign({ re: m.id }, answer(m)))), 0); },
    };
  };
  return sent;
}

test("IMAP goes through the helper with the keys it already has", async () => {
  reset();
  const I = { id: "imap:sam@icloud.com", kind: "imap", email: "sam@icloud.com", label: "iCloud", host: "imap.mail.me.com", port: 993, user: "sam" };
  mem.accounts = [I];
  mem["seen:" + I.id] = ["i:imap:sam@icloud.com:7:1", "i:imap:other@example.com:7:1"];
  const sent = fakeHelper(() => ({ ok: true, messages: [
    { key: "i:imap:sam@icloud.com:7:1", from: "Apple <a@example.com>", subject: "x", text: "Your code is 111111", at: now() },
    { key: "i:imap:sam@icloud.com:7:2", from: "Apple <a@example.com>", subject: "Your Apple ID Code", text: "Your Apple ID Code is: 635841.", at: now() },
  ] }));
  await AS.inbox.poll({ force: true });
  assert.equal(sent[0].op, "poll");
  assert.equal(sent[0].acct, I.id);
  assert.deepEqual(sent[0].skip, ["i:imap:sam@icloud.com:7:1"], "only this account's keys go along");
  assert.deepEqual(mem.codes.map((c) => c.code), ["635841"], "a key already read is dropped even if the helper sends it");
  assert.equal(mem.codes[0].from, "Apple");
});

test("helper errors keep their auth flag", async () => {
  reset();
  const I = { id: "imap:sam@icloud.com", kind: "imap", email: "sam@icloud.com" };
  mem.accounts = [I];
  fakeHelper(() => ({ error: "The helper doesn't know this account. Add it again.", auth: true, code: "unknown" }));
  await AS.inbox.poll({ force: true });
  assert.deepEqual(mem["st:" + I.id], Object.assign({}, mem["st:" + I.id], { ok: false, auth: true, nohost: false, error: "The helper doesn't know this account. Add it again." }));
});

test("a missing helper says how to install it", async () => {
  reset();
  const I = { id: "imap:sam@icloud.com", kind: "imap", email: "sam@icloud.com" };
  mem.accounts = [I];
  closePort();
  globalThis.browser.runtime.connectNative = () => { throw new Error("Specified native messaging host not found."); };
  await AS.inbox.poll({ force: true });
  const st = mem["st:" + I.id];
  assert.equal(st.nohost, true);
  assert.match(st.error, /install_host\.py/);
});
