/* AuthSkip: the popup. Reads storage (the background script is the only writer) and sends it messages: poll,
   fill, used, seen, addOAuth. While it is open it asks for a check every five seconds, so a code that has just been
   sent shows up as soon as the email does. */
(function (g) {
  const AS = g.AS;
  const api = AS.api;
  const esc = AS.esc;
  const app = document.getElementById("app");
  const msg = document.getElementById("msg");
  let S = { accounts: [], codes: [], settings: AS.DEFAULTS, meta: {}, st: {} };
  let busy = false, msgTimer = 0;

  async function load() {
    const r = await api.storage.local.get(["accounts", "codes", "settings", "meta"]);
    const accounts = r.accounts || [];
    const st = await api.storage.local.get(accounts.map((a) => "st:" + a.id));
    S = { accounts, codes: r.codes || [], settings: Object.assign({}, AS.DEFAULTS, r.settings || {}), meta: r.meta || {}, st };
  }

  function say(text) {
    msg.textContent = text;
    msg.hidden = false;
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => { msg.hidden = true; }, 3000);
  }

  function draw() {
    const now = Date.now();
    const fresh = S.settings.fresh * AS.MIN;
    const bad = S.accounts.map((a) => ({ a, s: S.st["st:" + a.id] })).filter((x) => x.s && !x.s.ok);
    const head = `<div class="bar"><h1>AuthSkip</h1>
      <button data-act="check" ${busy ? "disabled" : ""}>${busy ? "Checking…" : "Check now"}</button>
      <button data-act="settings" aria-label="Settings" title="Settings">Settings</button></div>`;
    const warns = bad.map(({ a, s }) => {
      const fix = s.nohost ? `<button data-act="settings" data-to="helper">Set up</button>` : s.auth ? `<button data-act="reauth" data-id="${esc(a.id)}" class="go">Sign in again</button>` : "";
      return `<div class="warn"><span><b>${esc(a.email)}</b><br><span class="bad">${esc(s.error)}</span></span>${fix}</div>`;
    }).join("");
    let body;
    if (!S.accounts.length) {
      body = `<p class="note">No accounts yet. Add a Gmail, Outlook or IMAP account and its codes will show up here.</p>
        <p class="note"><button data-act="settings" class="go">Add an account</button></p>`;
    } else if (!S.codes.length) {
      body = `<p class="note">No codes in the last day. Ask the site to send one and it will appear here within a few seconds.</p>`;
    } else {
      body = `<ul class="codes">${S.codes.slice(0, 8).map((c) => `
        <li class="${now - c.at < fresh ? "" : "old"} ${c.used ? "used" : ""}" data-id="${esc(c.id)}" data-code="${esc(c.code)}">
          <div class="num">${esc(AS.group(c.code))}</div>
          <div class="acts"><button data-act="copy">Copy</button><button data-act="fill" class="go">Fill</button></div>
          <div class="meta" title="${esc(c.subject)}"><b>${esc(c.from)}</b> · ${esc(AS.ago(c.at, now))}${c.used ? " · used" : ""} · ${esc(c.email)}</div>
        </li>`).join("")}</ul>`;
    }
    const n = S.accounts.length;
    const foot = `<div class="foot"><span>${n} account${n === 1 ? "" : "s"}</span><span>${S.meta.lastPoll ? "Checked " + esc(AS.ago(S.meta.lastPoll, now)) : ""}</span></div>`;
    AS.mount(app, head + warns + body + foot);
  }

  async function act(el) {
    const a = el.dataset.act;
    const li = el.closest("li");
    if (a === "settings") { await api.tabs.create({ url: api.runtime.getURL("src/pages/options.html" + (el.dataset.to ? "#" + el.dataset.to : "")) }); g.close(); }
    else if (a === "check") {
      busy = true; draw();
      await AS.send({ type: "poll", force: true }).catch(() => {});
      busy = false; await load(); draw();
    } else if (a === "copy") {
      try { await navigator.clipboard.writeText(li.dataset.code); say("Copied " + AS.group(li.dataset.code)); }
      catch (e) { say("The browser wouldn't let this copy. Select the code and press Ctrl+C."); }
    } else if (a === "fill") {
      const [tab] = await api.tabs.query({ active: true, currentWindow: true });
      const r = await AS.send({ type: "fill", id: li.dataset.id, tabId: tab && tab.id });
      if (r && r.ok) { say("Filled " + AS.group(r.code)); setTimeout(() => g.close(), 700); }
      else say((r && (r.reason || r.error)) || "Couldn't fill this page.");
    } else if (a === "reauth") {
      const acct = S.accounts.find((x) => x.id === el.dataset.id);
      el.disabled = true; el.textContent = "Signing in…";
      const r = await AS.send({ type: "addOAuth", kind: acct.kind, hint: acct.email });
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
    await load();
    draw();
    AS.send({ type: "seen" }).catch(() => {});
    const ping = () => AS.send({ type: "poll", fast: true }).catch(() => {});
    ping();
    setInterval(ping, 5000);
    setInterval(() => { load().then(draw); }, 20000);
  })();
})(globalThis);
