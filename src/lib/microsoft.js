/* PocketCodes: Outlook, Hotmail and Microsoft 365 mail through Microsoft Graph. The same shape as google.js: the
   authorization-code flow with PKCE in the browser's sign-in window, against an app registration of your own (a
   public client, so there is no secret), the Mail.Read scope, and one refresh token per account in tok:<id>.
   Written to Microsoft's documentation and checked only against recorded response shapes in tests/core.test.js;
   the author has no Microsoft account to try the sign-in with. */
(function (g) {
  const PC = (g.PC = g.PC || {});
  const api = PC.api;
  const BASE = "https://login.microsoftonline.com/common/oauth2/v2.0";
  const GRAPH = "https://graph.microsoft.com/v1.0/me";
  const SCOPE = "https://graph.microsoft.com/Mail.Read offline_access";

  const config = async () => {
    const c = await PC.store.get("microsoft", {});
    if (!c.clientId) throw new Error("Add your Microsoft application (client) ID first (Settings → Microsoft sign-in).");
    return c;
  };

  async function signIn(hint) {
    const c = await config();
    const state = PC.rand(16);
    const { verifier, challenge } = await PC.pkce();
    const redirect = api.identity.getRedirectURL();
    const q = {
      client_id: c.clientId, redirect_uri: redirect, response_type: "code", response_mode: "query", scope: SCOPE, state,
      code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account",
    };
    if (hint) q.login_hint = hint;
    const { code } = await PC.webAuth(BASE + "/authorize?" + PC.form(q), state);
    if (!code) throw new Error("Microsoft didn't send a sign-in code.");
    const t = await PC.post(BASE + "/token", { client_id: c.clientId, grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirect, scope: SCOPE });
    if (!t.refresh_token) throw new Error("Microsoft didn't give a long-lived sign-in. Check that the app allows public client flows.");
    const tok = { refresh: t.refresh_token, access: t.access_token, exp: Date.now() + (t.expires_in - 60) * 1000 };
    const me = await getJSON(`${GRAPH}?$select=mail,userPrincipalName`, tok.access);
    return { email: String(me.mail || me.userPrincipalName || "").toLowerCase(), tok };
  }

  async function getJSON(url, access) {
    const r = await g.fetch(url, { headers: { Authorization: "Bearer " + access, Prefer: 'outlook.body-content-type="text"' } });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error((data.error && data.error.message) || `Microsoft answered ${r.status}`); e.status = r.status; throw e; }
    return data;
  }

  async function access(account, force) {
    const key = "tok:" + account.id;
    const tok = await PC.store.get(key, null);
    if (!tok || !tok.refresh) throw PC.authError("Signed out. Sign in again.");
    if (!force && tok.access && tok.exp > Date.now() + 30e3) return tok.access;
    const c = await config();
    let t;
    try { t = await PC.post(BASE + "/token", { client_id: c.clientId, grant_type: "refresh_token", refresh_token: tok.refresh, scope: SCOPE }); }
    catch (e) {
      if (e.data && /invalid_grant|interaction_required/.test(e.data.error || "")) throw PC.authError("Microsoft ended this sign-in. Sign in again.");
      throw e;
    }
    await PC.store.set(key, { refresh: t.refresh_token || tok.refresh, access: t.access_token, exp: Date.now() + (t.expires_in - 60) * 1000 });
    return t.access_token;
  }

  function normalize(m) {
    const from = m.from && m.from.emailAddress ? `"${m.from.emailAddress.name || ""}" <${m.from.emailAddress.address || ""}>` : "";
    const body = m.body && m.body.content ? (m.body.contentType === "html" ? PC.codes.htmlToText(m.body.content) : m.body.content) : m.bodyPreview || "";
    return { key: "m:" + m.id, from, subject: m.subject || "", text: body, at: Date.parse(m.receivedDateTime) || Date.now() };
  }

  async function fetchRecent(account, { since, skip }) {
    const iso = new Date(since).toISOString();
    const url = `${GRAPH}/mailFolders/inbox/messages?$filter=${encodeURIComponent("receivedDateTime ge " + iso)}&$orderby=${encodeURIComponent("receivedDateTime desc")}&$top=20&$select=id,subject,from,receivedDateTime,bodyPreview,body`;
    let list;
    try { list = await getJSON(url, await access(account)); }
    catch (e) { if (e.status !== 401) throw e; list = await getJSON(url, await access(account, true)); }
    return (list.value || []).filter((m) => !skip.has("m:" + m.id)).map(normalize);
  }

  PC.microsoft = { signIn, fetchRecent, revoke: async () => {}, normalize, SCOPE };
})(globalThis);
