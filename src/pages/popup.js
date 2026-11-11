/* PocketCodes: the popup. Reads storage (the background script is the only writer) and sends it messages: poll,
   fill, used, seen, addOAuth, totp. While it is open it asks for a check every five seconds, so a code that has just
   been sent shows up as soon as the email does. Authenticators added in Settings show their current code below the
   list, counting down; the helper makes each one (the popup never sees a key). */
(function (g) {
  const PC = g.PC;
  const api = PC.api;
  const esc = PC.esc;
  const app = document.getElementById("app");
  const msg = document.getElementById("msg");
  let S = { accounts: [], codes: [], settings: PC.DEFAULTS, meta: {}, st: {} };
  let busy = false, msgTimer = 0, T = [];

  /** Whether the browser still lets the sign-in page script run (you can take its site access away in the add-ons page). */
  const siteAccess = () => (api.permissions && api.permissions.contains ? api.permissions.contains({ origins: ["<all_urls>"] }).catch(() => true) : Promise.resolve(true));

  async function load() {
    const r = await api.storage.local.get(["accounts", "codes", "settings", "meta", "authenticators"]);
    if ((r.authenticators || []).length !== T.length) await totps(); // added or removed one meanwhile
    const accounts = r.accounts || [];
    const st = await api.storage.local.get(accounts.map((a) => "st:" + a.id));
    S = { accounts, codes: r.codes || [], settings: Object.assign({}, PC.DEFAULTS, r.settings || {}), meta: r.meta || {}, st, access: await siteAccess() };
  }

  const secondsLeft = (t, now) => Math.max(0, t.left - Math.floor((now - T.at) / 1000));

  /** The authenticators' current codes, from the helper. */
  async function totps() {
    const r = await PC.send({ type: "totp" }).catch(() => null);
    T = (r && r.codes) || [];
    T.at = Date.now();
  }

  function say(text) {
    msg.textContent = text;
    msg.hidden = false;
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => { msg.hidden = true; }, 3000);
  }

  function draw() {
    const now = Date.now();
    const fresh = S.settings.fresh * PC.MIN;
    const bad = S.accounts.map((a) => ({ a, s: S.st["st:" + a.id] })).filter((x) => x.s && !x.s.ok);
    const head = `<div class="band"><span class="label">Pocket<i>codes</i></span>
      <button data-act="check" ${busy ? "disabled" : ""}>${busy ? "Checking…" : "Check now"}</button>
      <button data-act="settings" title="Settings">Settings</button></div>`;
    const warns = bad.map(({ a, s }) => {
      const fix = s.nohost ? `<button data-act="settings" data-to="icloud" class="sm">Set up</button>` : s.auth ? `<button data-act="reauth" data-id="${esc(a.id)}" class="go sm">Sign in again</button>` : "";
      return `<div class="warn card"><span><b>${esc(a.email)}</b><br><span class="bad">${esc(s.error)}</span></span>${fix}</div>`;
    }).join("");
    // the chip on sign-in pages is what makes codes appear by themselves, so say so when the browser took its access away
    const nudge = S.accounts.length && S.settings.page && !S.access
      ? `<div class="nudge card"><span>Let codes pop up by the box on sign-in pages</span><button data-act="settings" data-to="welcome" class="sm">Allow</button></div>` : "";
    let body;
    if (!S.accounts.length) {
      body = `<div class="empty card"><span class="lcd blank">--- ---</span>
        <p>Add your inboxes and every sign-in code shows up here, ready to fill.</p>
        <button data-act="settings" data-to="welcome" class="go big">Add an inbox</button></div>`;
    } else if (!S.codes.length) {
      body = `<div class="empty card"><span class="lcd blank">--- ---</span>
        <p>No codes in the last day. Ask the site to send one and it shows up here within seconds.</p></div>`;
    } else {
      body = `<ul class="codes">${S.codes.slice(0, 8).map((c) => `
        <li class="card ${now - c.at < fresh ? "" : "old"} ${c.used ? "used" : ""}" data-id="${esc(c.id)}" data-code="${esc(c.code)}">
          <span class="lcd" aria-label="Code ${esc(c.code)}">${esc(PC.group(c.code))}</span>
          <div class="acts"><button data-act="copy" class="sm">Copy</button><button data-act="fill" class="go">Fill</button></div>
          <div class="meta" title="${esc(c.subject)}"><b>${esc(c.from)}</b> · ${esc(PC.ago(c.at, now))}${c.used ? " · used" : ""} · ${esc(c.email)}</div>
        </li>`).join("")}</ul>`;
    }
    const left = (t) => secondsLeft(t, now);
    // a Duo code has no clock: it's good until it's used
    const about = (t) => (t.counter != null ? "Duo passcode" : `authenticator · <span data-left="${esc(t.id)}">${left(t)}</span> s · ${esc(t.site)}`);
    const auth = T.length ? `<ul class="codes">${T.map((t) => t.code ? `
        <li class="card" data-totp="${esc(t.id)}" data-code="${esc(t.code)}" ${t.counter != null ? `data-counter="${esc(t.counter)}"` : ""}>
          <span class="lcd" aria-label="Code ${esc(t.code)}">${esc(PC.group(t.code))}</span>
          <div class="acts"><button data-act="copy" class="sm">Copy</button><button data-act="fill" class="go">Fill</button></div>
          <div class="meta"><b>${esc(t.name)}</b> · ${about(t)}</div>
        </li>` : `<li class="card old"><div class="meta"><b>${esc(t.name)}</b> · <span class="bad">${esc(t.error || "No code")}</span></div></li>`).join("")}</ul>` : "";
    const n = S.accounts.length;
    const foot = `<div class="foot"><span>${n} inbox${n === 1 ? "" : "es"}</span><span>${S.meta.lastPoll ? "Checked " + esc(PC.ago(S.meta.lastPoll, now)) : ""}</span></div>`;
    PC.mount(app, head + warns + nudge + body + auth + foot);
  }

  async function act(el) {
    const a = el.dataset.act;
    const li = el.closest("li");
    if (a === "settings") { await api.tabs.create({ url: api.runtime.getURL("src/pages/options.html" + (el.dataset.to ? "#" + el.dataset.to : "")) }); g.close(); }
    else if (a === "check") {
      busy = true; draw();
      await PC.send({ type: "poll", force: true }).catch(() => {});
      busy = false; await load(); draw();
    } else if (a === "copy") {
      try { await navigator.clipboard.writeText(li.dataset.code); say("Copied " + PC.group(li.dataset.code)); }
      catch (e) { say("The browser wouldn't let this copy. Select the code and press Ctrl+C."); return; }
      // a copied Duo code is as good as used: the next sign-in gets the next one (this one stays on screen)
      if (li.dataset.counter) PC.send({ type: "used", totp: li.dataset.totp, counter: Number(li.dataset.counter) }).catch(() => {});
    } else if (a === "fill") {
      const [tab] = await api.tabs.query({ active: true, currentWindow: true });
      const r = await PC.send({ type: "fill", id: li.dataset.id, totp: li.dataset.totp, tabId: tab && tab.id });
      if (r && r.ok) { say("Filled " + PC.group(r.code)); setTimeout(() => g.close(), 700); }
      else say((r && (r.reason || r.error)) || "Couldn't fill this page.");
    } else if (a === "reauth") {
      const acct = S.accounts.find((x) => x.id === el.dataset.id);
      el.disabled = true; el.textContent = "Signing in…";
      const r = await PC.send({ type: "addOAuth", kind: acct.kind, hint: acct.email });
      if (r && r.error) say(r.error);
      await load(); draw();
    }
  }

  app.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]");
    if (b) act(b).catch((err) => say(String(err && err.message || err)));
  });
  api.storage.onChanged.addListener((_, area) => { if (area === "local") load().then(draw); });

  (async () => {
    await totps();
    await load();
    draw();
    // the authenticator codes count down every second, and come back new when one runs out
    // (only the seconds change in place, so a click on Fill never lands on a key that's being redrawn)
    setInterval(async () => {
      if (!T.length) return;
      const now = Date.now();
      if (T.some((t) => t.code && t.left != null && secondsLeft(t, now) <= 0)) { await totps(); draw(); return; }
      for (const el of app.querySelectorAll("[data-left]")) {
        const t = T.find((x) => x.id === el.dataset.left);
        if (t) el.textContent = String(secondsLeft(t, now));
      }
    }, 1000);
    PC.send({ type: "seen" }).catch(() => {});
    const ping = () => PC.send({ type: "poll", fast: true }).catch(() => {});
    ping();
    setInterval(ping, 5000);
    setInterval(() => { load().then(draw); }, 20000);
  })();
})(globalThis);
