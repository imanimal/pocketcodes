/* AuthSkip: iCloud and any other IMAP mailbox, through the helper in host/. A browser extension can't open an IMAP
   connection, so the helper (a stdlib Python script the browser starts through native messaging, installed once with
   host/install_host.py) does it. It checks the login when you add an account, then keeps the password in the
   operating system's own vault: this extension never stores it, and the helper never answers anything but this
   extension (the browser enforces that through allowed_origins / allowed_extensions in the helper's manifest).

   The wire format is one JSON object per message. Requests: { id, op, ... }. Answers: { re: id, ok: true, ... } or
   { re: id, error, auth?, code? }. Ops: hello {} → { version, os, data }; add { acct, host, port, user, email,
   password } → { user }; remove { acct }; poll { acct, since, limit, skip } → { messages: [{ key, from, subject,
   text, at }] }, keys "i:<acct>:<uidvalidity>:<uid>" (host/authskip_host.py's header). One port stays open
   while the browser needs it, so the helper keeps its IMAP connections between checks. */
(function (g) {
  const AS = (g.AS = g.AS || {});
  const api = AS.api;

  /** Servers worth a preset. iCloud and Yahoo want an app-specific password, not the account's own. */
  const presets = {
    icloud: { label: "iCloud", host: "imap.mail.me.com", port: 993, secret: "an app-specific password from account.apple.com → Sign-In and Security → App-Specific Passwords" },
    yahoo: { label: "Yahoo", host: "imap.mail.yahoo.com", port: 993, secret: "an app password from Yahoo's account security page" },
    aol: { label: "AOL", host: "imap.aol.com", port: 993, secret: "an app password from AOL's account security page" },
    fastmail: { label: "Fastmail", host: "imap.fastmail.com", port: 993, secret: "an app password from Fastmail's settings" },
    zoho: { label: "Zoho", host: "imap.zoho.com", port: 993, secret: "an app-specific password from Zoho's security page" },
    custom: { label: "Other IMAP", host: "", port: 993, secret: "the account's password, or an app password if it has two-step sign-in" },
  };

  const helperError = (msg) => {
    if (/not found|no such native|specified native|forbidden|not allowed/i.test(String(msg))) {
      return Object.assign(new Error("The helper isn't installed for this browser. Run host/install_host.py (Settings → IMAP helper shows the command)."), { code: "no-host" });
    }
    return new Error(String(msg || "The helper closed."));
  };

  let port = null;
  let seq = 0;
  const pending = new Map();

  function connect() {
    if (port) return port;
    const p = api.runtime.connectNative(AS.HOST);
    p.onMessage.addListener((m) => {
      const w = m && pending.get(m.re);
      if (!w) return;
      pending.delete(m.re);
      clearTimeout(w.t);
      if (m.error) w.rej(Object.assign(new Error(m.error), { auth: !!m.auth, code: m.code }));
      else w.res(m);
    });
    p.onDisconnect.addListener(() => {
      const err = helperError((api.runtime.lastError && api.runtime.lastError.message) || "The helper closed.");
      port = null;
      for (const w of pending.values()) { clearTimeout(w.t); w.rej(err); }
      pending.clear();
    });
    port = p;
    return p;
  }

  const call = (msg, ms) => new Promise((res, rej) => {
    let p;
    try { p = connect(); } catch (e) { return rej(helperError(e && e.message)); }
    const id = ++seq;
    const t = setTimeout(() => { pending.delete(id); rej(new Error("The helper didn't answer in time.")); }, ms || 25000);
    pending.set(id, { res, rej, t });
    try { p.postMessage(Object.assign({ id }, msg)); }
    catch (e) { pending.delete(id); clearTimeout(t); port = null; rej(helperError(e && e.message)); }
  });

  const imap = {
    presets,
    call,
    /** { version, os, data } from the helper, or an Error with code "no-host" when it isn't installed. */
    status: () => call({ op: "hello" }, 8000),
    /** Checks the login and hands the password to the helper's vault. Resolves with { user }, the login that worked. */
    add: (a, password) => call({ op: "add", acct: a.id, host: a.host, port: a.port, user: a.user || a.email, email: a.email, password }, 40000),
    remove: (id) => call({ op: "remove", acct: id }, 8000).catch(() => {}),
    revoke: async (a) => { await imap.remove(a.id); },
    async fetchRecent(a, { since, skip }) {
      // the keys already read go along, so the helper doesn't download those messages again
      const prefix = "i:" + a.id + ":";
      const r = await call({ op: "poll", acct: a.id, since, limit: 20, skip: [...skip].filter((k) => k.startsWith(prefix)) });
      return (r.messages || []).filter((m) => !skip.has(m.key));
    },
  };
  AS.imap = imap;
})(globalThis);
