/* AuthSkip: shared helpers for every context (background, popup, options, and the sign-in pages' content script).
   Classic scripts on globalThis.AS, no bundler and no npm. Load order: util → codes → google → microsoft → imap →
   inbox → background; the popup loads util → themes → icons → kit → popup; options util → themes → icons → kit →
   imap (for its presets) → look → options; the content script loads util → themes → fill → offer.
   The manifest's background list, background.js's importScripts and registerPage, and the <script> tags in
   src/pages/*.html stay in step.

   Storage is all storage.local. Only the background script writes the first group, so reads never race a write;
   the pages write the second group and read everything:
     accounts     [{ id, kind: google|microsoft|imap, email, label, host?, port?, user?, added }]   (no secrets)
     tok:<id>     a Google or Microsoft account's { refresh, access, exp }
     seen:<id>    the message keys already read for that account (newest last, capped)
     st:<id>      { ok, at, error?, auth? } how that account's last check went
     codes        [{ id, acct, email, kind, code, from, subject, at, found, seen, used }], newest first
     meta         { lastPoll }
     settings     the options below (DEFAULTS)
     google       { clientId, clientSecret }   your own Google Cloud OAuth client (docs in the README)
     microsoft    { clientId }                 your own Entra app registration
     themes       imported and edited themes, in the shared Pocket theme format (lib/themes.js)
   An iCloud or other IMAP password never reaches this storage: it goes straight to the helper (host/), which keeps
   it in the operating system's own vault. */
(function (g) {
  const AS = (g.AS = g.AS || {});
  const api = (AS.api = g.browser || g.chrome);
  const MIN = 60e3;
  AS.MIN = MIN;
  AS.HOST = "io.github.imanimal.authskip";

  const DEFAULTS = {
    v: 1,
    notify: true,       // a notification when a new code arrives
    every: 1,           // minutes between checks (1, 2 or 5)
    fresh: 10,          // minutes a code counts as fresh: offered for filling, and counted on the badge
    page: false,        // offer codes on sign-in pages (needs the all-sites permission; registers fill.js and offer.js)
    fill: "ask",        // on those pages: ask (show a card) | auto (fill it as soon as it arrives)
    // look (lib/themes.js; night: off | auto (with the system) | schedule | on)
    theme: "standard-light", nightTheme: "standard-dark", night: "auto", nightFrom: "20:00", nightTo: "07:00",
    type: "system",     // system (your system's font) | hyper (Atkinson Hyperlegible); Pocket themes bring their own
    motion: "full",     // full | off
  };
  AS.DEFAULTS = DEFAULTS;

  const store = (AS.store = {
    async get(k, d) { const r = await api.storage.local.get(k); return r[k] === undefined ? d : r[k]; },
    async set(k, v) { await api.storage.local.set({ [k]: v }); },
    async del(keys) { await api.storage.local.remove(keys); },
    async settings() { const r = await api.storage.local.get("settings"); return Object.assign({}, DEFAULTS, r.settings || {}); },
    async setSettings(patch) { const next = Object.assign(await store.settings(), patch); await api.storage.local.set({ settings: next }); return next; },
  });

  /** A promise-chain lock, so two overlapping tasks in this context take turns on the same key. */
  const locks = {};
  AS.mutex = (name, fn) => {
    const run = (locks[name] || Promise.resolve()).then(fn, fn);
    locks[name] = run.catch(() => {});
    return run;
  };

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  /** Our own markup (anything dynamic already through esc()) as a fragment, parsed inertly the way a <template> is.
      Everything the pages draw goes in through this, never innerHTML, which addons.mozilla.org's linter flags. */
  const frag = (html) => new DOMParser().parseFromString(`<template>${html}</template>`, "text/html").querySelector("template").content;
  AS.esc = esc;
  AS.frag = frag;
  AS.mount = (el, html) => el.replaceChildren(frag(html));

  /** "just now", "3 min ago", "2 h ago", "yesterday". */
  AS.ago = (t, now) => {
    const d = Math.max(0, (now == null ? Date.now() : now) - t);
    if (d < 45e3) return "just now";
    if (d < 90 * MIN) return `${Math.max(1, Math.round(d / MIN))} min ago`;
    if (d < 20 * 60 * MIN) return `${Math.round(d / (60 * MIN))} h ago`;
    return "yesterday";
  };

  /** A sender's display name: `"Google" <no-reply@accounts.google.com>` → Google; a bare address → its domain's name. */
  AS.sender = (from) => {
    const s = String(from || "").trim();
    const m = s.match(/^"?([^"<]*?)"?\s*<([^>]+)>$/);
    const name = m ? m[1].trim() : "";
    const addr = (m ? m[2] : s).trim();
    if (name && !name.includes("@")) return name;
    const dom = (addr.split("@")[1] || addr).split(".");
    const base = dom.length > 1 ? dom[dom.length - 2] : dom[0];
    return base ? base[0].toUpperCase() + base.slice(1) : "Unknown sender";
  };

  /** A code as it reads best: 482913 → "482 913", 12345678 → "1234 5678"; anything else as it is. */
  AS.group = (code) => (/^\d{6}$/.test(code) ? code.slice(0, 3) + " " + code.slice(3) : /^\d{8}$/.test(code) ? code.slice(0, 4) + " " + code.slice(4) : code);

  AS.KINDS = { google: "Gmail", microsoft: "Outlook", imap: "IMAP" };
  AS.kindLabel = (a) => (a.kind === "imap" && a.label) || AS.KINDS[a.kind] || a.kind;

  // ── OAuth helpers (Google and Microsoft share them) ──
  const b64url = (bytes) => {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  AS.b64url = b64url;
  AS.rand = (n) => b64url(g.crypto.getRandomValues(new Uint8Array(n || 32)));
  /** An RFC 7636 verifier and its S256 challenge. */
  AS.challenge = async (verifier) => b64url(new Uint8Array(await g.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  AS.pkce = async () => { const verifier = AS.rand(48); return { verifier, challenge: await AS.challenge(verifier) }; };
  /** Runs the browser's sign-in window at `url` and returns the redirect's query as an object. */
  AS.webAuth = async (url, state) => {
    let res;
    try { res = await api.identity.launchWebAuthFlow({ url, interactive: true }); }
    catch (e) { throw new Error(/cancel|closed|did not approve|user denied/i.test(String(e && e.message)) ? "Sign-in was cancelled." : String(e && e.message || e)); }
    if (!res) throw new Error("Sign-in was cancelled.");
    const q = new URL(res).searchParams;
    if (q.get("error")) throw new Error(q.get("error_description") || q.get("error"));
    if (q.get("state") !== state) throw new Error("The sign-in answer didn't match the request. Try again.");
    return { code: q.get("code") };
  };
  AS.form = (o) => new URLSearchParams(o).toString();
  /** A POST of form fields that returns JSON; non-2xx answers become Errors carrying `.status` and `.data`. */
  AS.post = async (url, fields) => {
    const r = await g.fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: AS.form(fields) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(data.error_description || (data.error && data.error.message) || data.error || `HTTP ${r.status}`); e.status = r.status; e.data = data; throw e; }
    return data;
  };
  /** Marks an error as needing the person to sign in again, which the pages show as a "Sign in again" key. */
  AS.authError = (msg) => Object.assign(new Error(msg), { auth: true });

  AS.send = (msg) => api.runtime.sendMessage(msg);
})(globalThis);
