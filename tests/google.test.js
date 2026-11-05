/* PocketCodes: tests for Gmail's sign-in plumbing (src/lib/google.js) with a fake browser API and a fake Google.
   Run: node --test tests/google.test.js
   Which client signs in (built-in in Firefox, your own when entered), the redirect each one uses, and that a refresh
   goes back to the client that issued the sign-in. */
const test = require("node:test");
const assert = require("node:assert/strict");

const mem = {};
let redirectBase = "https://0123456789abcdef.extensions.allizom.org/";
let lastAuthUrl = null;
const posts = [];
globalThis.browser = {
  storage: { local: {
    async get(k) { const keys = Array.isArray(k) ? k : [k]; const r = {}; for (const x of keys) if (x in mem) r[x] = JSON.parse(JSON.stringify(mem[x])); return r; },
    async set(o) { for (const k in o) mem[k] = JSON.parse(JSON.stringify(o[k])); },
    async remove(keys) { for (const k of [].concat(keys)) delete mem[k]; },
  } },
  identity: {
    getRedirectURL: () => redirectBase,
    async launchWebAuthFlow({ url }) {
      lastAuthUrl = new URL(url);
      const back = new URL(lastAuthUrl.searchParams.get("redirect_uri"));
      back.searchParams.set("code", "auth-code");
      back.searchParams.set("state", lastAuthUrl.searchParams.get("state"));
      return back.href;
    },
  },
};
globalThis.fetch = async (url, opts) => {
  const ok = (data) => ({ ok: true, status: 200, json: async () => data });
  if (String(url).includes("oauth2.googleapis.com/token")) {
    const f = Object.fromEntries(new URLSearchParams(opts.body));
    posts.push(f);
    if (f.grant_type === "authorization_code") return ok({ access_token: "a1", refresh_token: "r1", expires_in: 3600, scope: "https://www.googleapis.com/auth/gmail.readonly" });
    return ok({ access_token: "a2", expires_in: 3600 });
  }
  if (String(url).endsWith("/profile")) return ok({ emailAddress: "You@Example.com" });
  if (String(url).includes("/messages")) return ok({ messages: [] });
  throw new Error("unexpected fetch " + url);
};
require("../src/lib/util.js");
require("../src/lib/client.js");
require("../src/lib/codes.js");
require("../src/lib/google.js");
const { PC } = globalThis;
const reset = () => { for (const k of Object.keys(mem)) delete mem[k]; posts.length = 0; lastAuthUrl = null; };

test("Firefox with the built-in client signs in through the loopback redirect", async () => {
  reset();
  PC.CLIENT.google = { id: "builtin-id", secret: "builtin-secret" };
  const { email, tok } = await PC.google.signIn();
  assert.equal(email, "you@example.com");
  assert.equal(tok.via, "builtin");
  assert.equal(lastAuthUrl.searchParams.get("client_id"), "builtin-id");
  assert.equal(lastAuthUrl.searchParams.get("redirect_uri"), "http://127.0.0.1/mozoauth2/0123456789abcdef");
  assert.equal(lastAuthUrl.searchParams.get("scope"), "https://www.googleapis.com/auth/gmail.readonly");
  assert.equal(lastAuthUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(posts[0].client_secret, "builtin-secret");
  assert.equal(posts[0].redirect_uri, "http://127.0.0.1/mozoauth2/0123456789abcdef", "the token exchange repeats the same redirect");
});

test("your own client wins for new sign-ins, with the extension's own redirect", async () => {
  reset();
  PC.CLIENT.google = { id: "builtin-id", secret: "builtin-secret" };
  mem.google = { clientId: "own-id", clientSecret: "own-secret" };
  const { tok } = await PC.google.signIn();
  assert.equal(tok.via, "own");
  assert.equal(lastAuthUrl.searchParams.get("client_id"), "own-id");
  assert.equal(lastAuthUrl.searchParams.get("redirect_uri"), redirectBase);
});

test("a refresh goes back to the client that issued the sign-in", async () => {
  reset();
  PC.CLIENT.google = { id: "builtin-id", secret: "builtin-secret" };
  mem.google = { clientId: "own-id", clientSecret: "own-secret" }; // entered after this account signed in
  mem["tok:google:you@example.com"] = { via: "builtin", refresh: "r1", access: "old", exp: 0 };
  await PC.google.fetchRecent({ id: "google:you@example.com" }, { since: Date.now() - 60e3, skip: new Set() });
  assert.equal(posts[0].grant_type, "refresh_token");
  assert.equal(posts[0].client_id, "builtin-id");
  assert.equal(mem["tok:google:you@example.com"].via, "builtin", "the refreshed token keeps its client");
});

test("a token from before `via` existed refreshes against your own client", async () => {
  reset();
  mem.google = { clientId: "own-id", clientSecret: "own-secret" };
  mem["tok:google:you@example.com"] = { refresh: "r1", access: "old", exp: 0 };
  await PC.google.fetchRecent({ id: "google:you@example.com" }, { since: Date.now() - 60e3, skip: new Set() });
  assert.equal(posts[0].client_id, "own-id");
});

test("Chrome (no loopback redirect) never uses the built-in client", async () => {
  reset();
  redirectBase = "https://kammpeiopjjhipmdggclkefddnlagnpk.chromiumapp.org/";
  try {
    PC.CLIENT.google = { id: "builtin-id", secret: "builtin-secret" };
    await assert.rejects(PC.google.signIn(), /no built-in Google sign-in/);
    mem.google = { clientId: "own-id", clientSecret: "own-secret" };
    const { tok } = await PC.google.signIn();
    assert.equal(tok.via, "own");
  } finally {
    redirectBase = "https://0123456789abcdef.extensions.allizom.org/";
  }
});

test("a blank build with no client of your own asks for one", async () => {
  reset();
  PC.CLIENT.google = { id: "", secret: "" };
  await assert.rejects(PC.google.signIn(), /Add your own Google client/);
});
