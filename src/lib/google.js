/* PocketCodes: Gmail. Each Google account signs in on its own through the browser's sign-in window (the
   authorization-code flow with PKCE) against an OAuth client in your own free Google Cloud project, so there is no
   limit on how many accounts you add and no server in the middle. The only scope is gmail.readonly. Tokens live in
   storage.local under tok:<id>; the refresh token is exchanged for a one-hour access token whenever it is needed.

   A provider is { signIn, fetchRecent, revoke }: signIn returns { email, tok }, and fetchRecent(account, { since,
   skip }) returns the messages newer than `since` whose key isn't in `skip`, as { key, from, subject, text, at }. */
(function (g) {
  const PC = (g.PC = g.PC || {});
  const api = PC.api;
  const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
  const TOKEN = "https://oauth2.googleapis.com/token";
  const REVOKE = "https://oauth2.googleapis.com/revoke";
  const API = "https://gmail.googleapis.com/gmail/v1/users/me";
  const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

  const config = async () => {
    const c = await PC.store.get("google", {});
    if (!c.clientId || !c.clientSecret) throw new Error("Add your Google client ID and secret first (Settings → Google sign-in).");
    return c;
  };

  async function signIn(hint) {
    const c = await config();
    const state = PC.rand(16);
    const { verifier, challenge } = await PC.pkce();
    const redirect = api.identity.getRedirectURL();
    const q = {
      client_id: c.clientId, redirect_uri: redirect, response_type: "code", scope: SCOPE, state,
      code_challenge: challenge, code_challenge_method: "S256", access_type: "offline",
      prompt: hint ? "consent" : "select_account consent",
    };
    if (hint) q.login_hint = hint;
    const { code } = await PC.webAuth(AUTH + "?" + PC.form(q), state);
    if (!code) throw new Error("Google didn't send a sign-in code.");
    const t = await PC.post(TOKEN, { client_id: c.clientId, client_secret: c.clientSecret, code, code_verifier: verifier, redirect_uri: redirect, grant_type: "authorization_code" });
    if (!String(t.scope || "").includes("gmail.readonly")) throw new Error("PocketCodes needs permission to read mail. Sign in again and leave \"Read your email\" ticked.");
    if (!t.refresh_token) throw new Error("Google didn't give a long-lived sign-in. Remove PocketCodes at myaccount.google.com/permissions and try again.");
    const tok = { refresh: t.refresh_token, access: t.access_token, exp: Date.now() + (t.expires_in - 60) * 1000 };
    const p = await getJSON(`${API}/profile`, tok.access);
    return { email: String(p.emailAddress || "").toLowerCase(), tok };
  }

  async function getJSON(url, access) {
    const r = await g.fetch(url, { headers: { Authorization: "Bearer " + access } });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error((data.error && data.error.message) || `Gmail answered ${r.status}`); e.status = r.status; throw e; }
    return data;
  }

  /** A usable access token for the account, refreshing (and saving) it when it is about to lapse. */
  async function access(account, force) {
    const key = "tok:" + account.id;
    const tok = await PC.store.get(key, null);
    if (!tok || !tok.refresh) throw PC.authError("Signed out. Sign in again.");
    if (!force && tok.access && tok.exp > Date.now() + 30e3) return tok.access;
    const c = await config();
    let t;
    try { t = await PC.post(TOKEN, { client_id: c.clientId, client_secret: c.clientSecret, refresh_token: tok.refresh, grant_type: "refresh_token" }); }
    catch (e) {
      if (e.data && e.data.error === "invalid_grant") throw PC.authError("Google ended this sign-in. Sign in again.");
      throw e;
    }
    await PC.store.set(key, { refresh: tok.refresh, access: t.access_token, exp: Date.now() + (t.expires_in - 60) * 1000 });
    return t.access_token;
  }

  async function gmail(account, path) {
    try { return await getJSON(API + path, await access(account)); }
    catch (e) {
      if (e.status === 401) return getJSON(API + path, await access(account, true));
      if (e.status === 403 && /disabled|not been used/i.test(e.message)) throw new Error("The Gmail API is off in your Google Cloud project. Enable it, then check again.");
      throw e;
    }
  }

  const b64 = (s) => {
    const bin = atob(String(s).replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  };
  const header = (m, name) => {
    const h = ((m.payload && m.payload.headers) || []).find((x) => x.name.toLowerCase() === name);
    return h ? h.value : "";
  };
  /** The readable text of a Gmail message: its text/plain parts, else its HTML parts as text, else the snippet. */
  function bodyText(part, acc) {
    acc = acc || { plain: [], html: [] };
    if (!part) return acc;
    const type = String(part.mimeType || "").toLowerCase();
    const data = part.body && part.body.data;
    if (data && type === "text/plain") acc.plain.push(b64(data));
    else if (data && type === "text/html") acc.html.push(PC.codes.htmlToText(b64(data)));
    for (const p of part.parts || []) bodyText(p, acc);
    return acc;
  }
  function normalize(m) {
    const t = bodyText(m.payload);
    const text = (t.plain.length ? t.plain : t.html).join("\n") || m.snippet || "";
    return { key: "g:" + m.id, from: header(m, "from"), subject: header(m, "subject"), text, at: Number(m.internalDate) || Date.now() };
  }

  async function fetchRecent(account, { since, skip }) {
    const q = encodeURIComponent("after:" + Math.floor(since / 1000));
    const list = await gmail(account, `/messages?labelIds=INBOX&maxResults=20&q=${q}`);
    const out = [];
    for (const { id } of list.messages || []) {
      if (skip.has("g:" + id)) continue;
      out.push(normalize(await gmail(account, `/messages/${id}?format=full`)));
    }
    return out;
  }

  /** Best effort: tell Google this app no longer needs the sign-in. */
  async function revoke(account) {
    const tok = await PC.store.get("tok:" + account.id, null);
    if (tok && tok.refresh) await PC.post(REVOKE, { token: tok.refresh }).catch(() => {});
  }

  PC.google = { signIn, fetchRecent, revoke, normalize, SCOPE };
})(globalThis);
