/* AuthSkip: the toolbar popup (Alt+Shift+C). The codes found in the last day, newest first, each with Copy and Fill;
   any account that needs attention above them. Reads storage (the background script is the only writer of what it
   shows) and sends it messages: poll, fill, seen, addOAuth. While it is open it asks for a check every five seconds,
   so a code that has just been sent shows up as soon as the email does. Painted in the theme from settings. */
(function (g) {
  const AS = g.AS, api = AS.api, T = AS.themes, K = AS.kit, esc = AS.esc;
  const app = document.getElementById("app"), root = document.documentElement;
  let S = { accounts: [], codes: [], settings: AS.DEFAULTS, themes: [], meta: {}, st: {} };
  let busy = false;

  async function load() {
    const r = await api.storage.local.get(["accounts", "codes", "settings", "themes", "meta"]);
    const accounts = r.accounts || [];
    const st = accounts.length ? await api.storage.local.get(accounts.map((a) => "st:" + a.id)) : {};
    S = { accounts, codes: r.codes || [], settings: Object.assign({}, AS.DEFAULTS, r.settings || {}), themes: r.themes || [], meta: r.meta || {}, st };
  }

  function draw() {
    T.look(S.settings, T.BUILTIN.concat(S.themes), root);
    const now = Date.now(), fresh = S.settings.fresh * AS.MIN;
    const head = `<div class="pp-head"><span class="as-logo" aria-hidden="true"><i></i><i></i><i></i></span><b>AuthSkip</b>
      ${K.key({ icon: "refresh", title: busy ? "Checking…" : "Check now", cls: "ghost", act: "check", disabled: busy })}
      ${K.key({ icon: "gear", title: "Settings", cls: "ghost", act: "settings" })}</div>`;

    const bad = S.accounts.map((a) => ({ a, s: S.st["st:" + a.id] })).filter((x) => x.s && !x.s.ok);
    const warns = bad.length ? `<div class="pp-sec">${bad.map(({ a, s }) => {
      const fix = s.nohost ? K.key({ label: "Set up", cls: "sm", act: "settings", attrs: 'data-to="helper"' })
        : s.auth && a.kind !== "imap" ? K.key({ label: "Sign in again", cls: "sm primary", act: "reauth", id: a.id })
        : s.auth ? K.key({ label: "Add again", cls: "sm", act: "settings", attrs: 'data-to="accounts"' }) : "";
      return `<div class="pp-warn"><div><b>${esc(a.email)}</b><span>${esc(s.error)}</span></div>${fix}</div>`;
    }).join("")}</div>` : "";

    let body;
    if (!S.accounts.length) {
      body = `<div class="pp-empty"><p>Add a Gmail, Outlook or iCloud account and its sign-in codes show up here.</p>${K.key({ label: "Add an account", icon: "plus", cls: "primary", act: "settings", attrs: 'data-to="accounts"' })}</div>`;
    } else if (!S.codes.length) {
      body = `<div class="pp-empty"><p>No codes in the last day. Ask a site to send one; it shows up here a few seconds after the email arrives.</p></div>`;
    } else {
      // Fill is the one accent key, on the newest code that is still fresh and unused
      const top = S.codes.find((c) => !c.used && now - c.at < fresh);
      body = `<ul class="pp-codes">${S.codes.slice(0, 8).map((c) => {
        const old = now - c.at >= fresh;
        const state = c.used ? '<span class="as-tag quiet">Used</span>' : old ? '<span class="as-tag quiet">Older</span>' : "";
        return `<li class="pp-code${old ? " old" : ""}${c.used ? " used" : ""}" data-id="${esc(c.id)}" data-code="${esc(c.code)}">
          ${K.stat(c.from, AS.group(c.code), "", "", c.subject)}
          <div class="pp-acts">${K.key({ icon: "copy", title: "Copy", act: "copy" })}${K.key({ label: "Fill", cls: c === top ? "primary" : "", act: "fill" })}</div>
          <div class="pp-meta">${state}<span>${esc(AS.ago(c.at, now))} · ${esc(c.email)}</span></div></li>`;
      }).join("")}</ul>`;
    }
    const n = S.accounts.length;
    const foot = n ? `<div class="pp-foot"><span>${n} account${n === 1 ? "" : "s"}</span><span>${busy ? "Checking…" : S.meta.lastPoll ? "Checked " + esc(AS.ago(S.meta.lastPoll, now)) : ""}</span></div>` : "";
    app.replaceChildren(AS.frag(head + warns + body + foot));
  }

  async function act(el) {
    const a = el.dataset.act, li = el.closest("li");
    if (a === "settings") { await api.tabs.create({ url: api.runtime.getURL("src/pages/options.html" + (el.dataset.to ? "#" + el.dataset.to : "")) }); g.close(); }
    else if (a === "check") {
      busy = true; draw();
      await AS.send({ type: "poll", force: true }).catch(() => {});
      busy = false; await load(); draw();
    } else if (a === "copy") {
      try { await navigator.clipboard.writeText(li.dataset.code); K.toast("Copied " + AS.group(li.dataset.code)); }
      catch (e) { K.toast("The browser wouldn't copy here. Select the code and press Ctrl+C."); }
    } else if (a === "fill") {
      const [tab] = await api.tabs.query({ active: true, currentWindow: true });
      const r = await AS.send({ type: "fill", id: li.dataset.id, tabId: tab && tab.id });
      if (r && r.ok) { K.toast("Filled " + AS.group(r.code)); setTimeout(() => g.close(), 700); }
      else K.toast((r && (r.reason || r.error)) || "Couldn't fill this page.");
    } else if (a === "reauth") {
      const acct = S.accounts.find((x) => x.id === el.dataset.id);
      el.disabled = true;
      const r = await AS.send({ type: "addOAuth", kind: acct.kind, hint: acct.email });
      if (r && r.error) K.toast(r.error);
      await load(); draw();
    }
  }

  app.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (b) act(b).catch((err) => K.toast(String((err && err.message) || err)));
  });
  api.storage.onChanged.addListener((_, area) => { if (area === "local") load().then(draw); });
  if (g.matchMedia) g.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", draw);

  (async () => {
    await load();
    draw();
    AS.send({ type: "seen" }).catch(() => {});
    const ping = () => AS.send({ type: "poll", fast: true }).catch(() => {});
    ping();
    setInterval(ping, 5000);
    setInterval(() => { load().then(draw); }, 20000);
  })();
})(globalThis);
