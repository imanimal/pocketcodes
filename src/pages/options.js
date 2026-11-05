/* PocketCodes: the settings page (opens in a tab, and on install). Reads storage; the background script does every
   account write, so adding, signing in again and removing are messages. The pages write only settings, google and
   microsoft. It leads with three steps (add inboxes, turn on codes on sign-in pages, the fill key); your own Google
   client, Outlook and the IMAP helper's details sit under Advanced. #welcome, #icloud and #helper jump to their part. */
(function (g) {
  const PC = g.PC;
  const api = PC.api;
  const esc = PC.esc;
  const app = document.getElementById("app");
  const redirect = (() => { try { return api.identity.getRedirectURL(); } catch (e) { return ""; } })();
  // the built-in Google client (client.js) works only where Firefox's loopback redirect does
  const builtIn = !!(PC.CLIENT && PC.CLIENT.google.id && PC.CLIENT.google.secret && /\.extensions\.allizom\.org\//.test(redirect));
  const CMD = "python host/install_host.py";
  let S = { accounts: [], settings: PC.DEFAULTS, google: {}, microsoft: {}, st: {}, meta: {}, codes: [] };
  let ui = { addImap: g.location.hash === "#icloud", preset: "icloud", note: "", noteBad: false, helper: null, armed: null, working: null, open: g.location.hash === "#helper" ? "helper" : null };

  async function load() {
    const r = await api.storage.local.get(["accounts", "settings", "google", "microsoft", "meta", "codes"]);
    const accounts = r.accounts || [];
    const st = await api.storage.local.get(accounts.map((a) => "st:" + a.id));
    S = { accounts, settings: Object.assign({}, PC.DEFAULTS, r.settings || {}), google: r.google || {}, microsoft: r.microsoft || {}, st, meta: r.meta || {}, codes: r.codes || [] };
  }

  const googleReady = () => builtIn || !!(S.google.clientId && S.google.clientSecret);

  const stat = (a) => {
    const s = S.st["st:" + a.id];
    if (!s) return `<span class="quiet">Not checked yet</span>`;
    return s.ok ? `<span class="quiet">Checked ${esc(PC.ago(s.at))}</span>` : `<span class="bad">${esc(s.error)}</span>`;
  };

  function acctRow(a) {
    const s = S.st["st:" + a.id];
    const again = s && !s.ok && s.auth ? `<button data-act="reauth" data-id="${esc(a.id)}" class="go sm">Sign in again</button>` : "";
    const fix = s && !s.ok && s.nohost ? `<button data-act="openHelper" class="sm">Set up the helper</button>` : "";
    const rm = ui.armed === a.id ? `<button data-act="remove" data-id="${esc(a.id)}" class="bad sm">Remove? Press again</button>` : `<button data-act="remove" data-id="${esc(a.id)}" class="sm">Remove</button>`;
    return `<div class="acct box"><div class="who"><span><span class="tag">${esc(PC.kindLabel(a))}</span><b>${esc(a.email)}</b></span>${stat(a)}</div>
      <div class="row">${again}${fix}${rm}</div></div>`;
  }

  function helperLine() {
    const h = ui.helper;
    return `<div class="row"><button data-act="helper" class="sm">Check the helper</button>
      <span class="status ${h && h.ok ? "good" : "bad"}">${h ? esc(h.text) : ""}</span></div>`;
  }
  const helperSteps = () => `<p>iCloud and other IMAP inboxes go through a small helper program, because an extension can't open an IMAP connection.
      It's one Python file with no dependencies, and it only answers PocketCodes. Install it once from the PocketCodes folder, then restart Firefox:</p>
    <div class="copy"><input type="text" readonly value="${esc(CMD)}" aria-label="Command"><button data-act="copyCmd">Copy</button></div>`;

  function imapForm() {
    const p = PC.imap.presets[ui.preset];
    const custom = ui.preset === "custom";
    const h = ui.helper;
    const missing = h && !h.ok && h.code === "no-host";
    return `<form class="box" data-form="imap" autocomplete="off">
      ${missing ? `<div class="box">${helperSteps()}${helperLine()}</div>` : ""}
      <div class="grid2">
        <label>Provider<select name="preset">${Object.entries(PC.imap.presets).map(([k, v]) => `<option value="${k}" ${k === ui.preset ? "selected" : ""}>${esc(v.label)}</option>`).join("")}</select></label>
        <label>Email address<input type="email" name="email" required autocomplete="off" placeholder="${ui.preset === "icloud" ? "you@icloud.com" : "you@example.com"}"></label>
      </div>
      <label>${ui.preset === "icloud" ? "App-specific password" : "Password"}<input type="password" name="password" required autocomplete="off" placeholder="${ui.preset === "icloud" ? "xxxx-xxxx-xxxx-xxxx" : ""}"></label>
      <p class="quiet">Use ${p.link ? `<a href="${esc(p.link)}" target="_blank" rel="noopener">${esc(p.secret)}</a>` : esc(p.secret)}. ${ui.preset === "icloud" ? "Your Apple ID password won't work. " : ""}It goes straight to the helper, which keeps it in this computer's own vault; the extension never stores it.</p>
      ${custom ? `<div class="grid2"><label>IMAP server<input type="text" name="host" placeholder="imap.example.com"></label><label>Port<input type="number" name="port" value="993"></label></div>
        <label>Username (if it isn't the address)<input type="text" name="user" autocomplete="off"></label>` : ""}
      <div class="row"><button class="go" type="submit" ${ui.working === "imap" ? "disabled" : ""}>${ui.working === "imap" ? "Checking the login…" : "Add inbox"}</button>
        <button type="button" data-act="cancelImap">Cancel</button></div>
    </form>`;
  }

  function draw() {
    const s = S.settings;
    const g1 = S.google, m1 = S.microsoft;
    const now = Date.now();
    const top = S.codes.find((c) => !c.used && now - c.at < s.fresh * PC.MIN);
    const n = S.accounts.length;
    const gmail = googleReady()
      ? `<button data-act="addOAuth" data-kind="google" class="go" ${ui.working === "google" ? "disabled" : ""}>${ui.working === "google" ? "Waiting for Google…" : "Add Gmail"}</button>`
      : `<button data-act="openGoogle">Add Gmail</button>`;
    PC.mount(app, `
      <section class="hero card">
        <span class="lcd ${top ? "" : "blank"}" aria-label="${top ? "Newest code " + esc(top.code) : "No fresh code"}">${top ? esc(PC.group(top.code)) : "--- ---"}</span>
        <div class="what"><h1>PocketCodes</h1>
          <p class="quiet">Sign-in codes from every inbox you add, in one list and right by the box that asks for them. It only reads mail, and nothing leaves your browser.</p></div>
      </section>

      <section class="panel card" id="welcome">
        <div class="band"><span class="label">Get started</span></div>
        <div class="in steps">
          <div class="step"><span class="n ${n ? "done" : ""}">1</span><h3>Add your inboxes</h3>
            <div class="body">
              <div class="row">${gmail}
                <button data-act="showImap" data-preset="icloud" ${ui.addImap ? "disabled" : ""}>Add iCloud</button>
                <button data-act="addOAuth" data-kind="microsoft" ${ui.working === "microsoft" ? "disabled" : ""}>${ui.working === "microsoft" ? "Waiting for Microsoft…" : "Add Outlook"}</button>
                <button data-act="showImap" data-preset="custom" ${ui.addImap ? "disabled" : ""}>Other IMAP</button></div>
              <p class="quiet">${builtIn ? "Gmail is just a Google sign-in. Google says PocketCodes isn't verified (it's a free, personal app): choose <b>Continue</b> there. " : ""}Add as many as you like; each one is checked on its own.</p>
              ${ui.addImap ? imapForm() : ""}
              <p class="status ${ui.noteBad ? "bad" : "good"}" role="status">${esc(ui.note)}</p>
              ${n ? S.accounts.map(acctRow).join("") : ""}
            </div></div>
          <div class="step"><span class="n ${s.page ? "done" : ""}">2</span><h3>Show codes on sign-in pages</h3>
            <div class="body">
              <p>A small chip appears by any code box with the newest code, and PocketCodes checks your inboxes every few seconds while one is open. ${s.page ? "" : "Firefox will ask to let it run on all sites; it only looks at code boxes and the form around them, and sends nothing anywhere."}</p>
              <div class="row">${s.page
                ? `<span class="good"><b>On.</b></span><span class="quiet">When a code arrives:</span><select data-set="settings.fill" aria-label="When a code arrives"><option value="ask" ${s.fill === "ask" ? "selected" : ""}>Show it, I press Fill</option><option value="auto" ${s.fill === "auto" ? "selected" : ""}>Fill it in for me</option></select><button data-act="pageOff" class="sm">Turn off</button>`
                : `<button data-act="pageOn" class="go">Turn on</button>`}</div>
            </div></div>
          <div class="step"><span class="n done">3</span><h3>Fill with one key</h3>
            <div class="body"><p>On any page, <kbd>Alt+Shift+F</kbd> fills the newest code, and <kbd>Alt+Shift+C</kbd> opens the list. The toolbar button's <b>Fill</b> does the same.</p></div></div>
        </div>
      </section>

      <section class="panel card" id="settings">
        <div class="band"><span class="label">Settings</span></div>
        <div class="in">
          <label class="check"><input type="checkbox" data-set="settings.notify" ${s.notify ? "checked" : ""}><span>Show a notification when a new code arrives</span></label>
          <div class="grid2">
            <label>Check every<select data-set="settings.every" data-num="1">${[1, 2, 5].map((x) => `<option value="${x}" ${s.every === x ? "selected" : ""}>${x} minute${x > 1 ? "s" : ""}</option>`).join("")}</select></label>
            <label>A code counts as fresh for<select data-set="settings.fresh" data-num="1">${[5, 10, 15, 30].map((x) => `<option value="${x}" ${s.fresh === x ? "selected" : ""}>${x} minutes</option>`).join("")}</select></label>
          </div>
          <p class="quiet">Change the shortcuts on Firefox's extension shortcuts page (Add-ons › gear › Manage extension shortcuts).</p>
          <div class="row"><button data-act="clear" class="sm">Forget the codes found so far</button></div>
        </div>
      </section>

      <section class="panel card" id="advanced">
        <div class="band"><span class="label">Advanced</span></div>
        <div class="in">
          <details id="google" ${ui.open === "google" ? "open" : ""}><summary>Use your own Google client</summary><div class="in">
            <p class="quiet">${builtIn ? "Not needed: Gmail signs in with PocketCodes' built-in client. Your own client takes over for new sign-ins if you enter one." : "This copy of PocketCodes has no built-in Google sign-in (a copy loaded from its folder, or Chrome), so Gmail needs a free OAuth client of your own. It takes about five minutes."}</p>
            <ol>
              <li>In <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener">Google Cloud</a>, create a project and turn on the <a href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank" rel="noopener">Gmail API</a>.</li>
              <li>Under <b>Google Auth Platform</b>, set it up as <b>External</b>, add the scope <code>gmail.readonly</code>, and publish the app (it stays "unverified", which is fine for you). Left in testing, sign-ins end after 7 days.</li>
              <li>Under <b>Clients</b>, create a <b>Web application</b> client with this redirect URI:</li>
            </ol>
            <div class="copy"><input type="text" readonly value="${esc(redirect)}" aria-label="Redirect URI"><button data-act="copyRedirect">Copy</button></div>
            <div class="grid2">
              <label>Client ID<input type="text" data-set="google.clientId" value="${esc(g1.clientId || "")}" autocomplete="off" spellcheck="false"></label>
              <label>Client secret<input type="password" data-set="google.clientSecret" value="${esc(g1.clientSecret || "")}" autocomplete="off"></label>
            </div>
            <p class="quiet">School and work Google accounts (a university's, say) may block apps their admin hasn't approved. If sign-in says access is blocked, forward that account's mail to a Gmail address you can add.</p>
          </div></details>
          <details id="helper" ${ui.open === "helper" ? "open" : ""}><summary>IMAP helper (iCloud and other IMAP)</summary><div class="in">${helperSteps()}${helperLine()}</div></details>
          <details id="microsoft" ${ui.open === "microsoft" ? "open" : ""}><summary>Outlook sign-in</summary><div class="in">
            <p class="quiet">Only needed for Outlook, Hotmail or Microsoft 365. Register an app in <a href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noopener">Microsoft Entra</a> with account type <b>Personal and work accounts</b>, add a <b>Mobile and desktop applications</b> platform with this redirect URI, then paste the application (client) ID. This one is untested.</p>
            <div class="copy"><input type="text" readonly value="${esc(redirect)}" aria-label="Redirect URI"><button data-act="copyRedirect">Copy</button></div>
            <label>Application (client) ID<input type="text" data-set="microsoft.clientId" value="${esc(m1.clientId || "")}" autocomplete="off" spellcheck="false"></label>
          </div></details>
        </div>
      </section>`);
    if (g.location.hash && !draw.scrolled) { draw.scrolled = true; const t = document.querySelector(g.location.hash === "#icloud" ? "#welcome" : g.location.hash); if (t) t.scrollIntoView(); }
  }

  const note = (text, bad) => { ui.note = text; ui.noteBad = !!bad; draw(); };

  async function setPath(path, value) {
    const [root, key] = path.split(".");
    if (root === "settings") { await PC.store.setSettings({ [key]: value }); await PC.send({ type: "settings" }).catch(() => {}); }
    else { const cur = await PC.store.get(root, {}); cur[key] = value; await PC.store.set(root, cur); }
  }

  async function checkHelper() {
    ui.helper = { ok: false, text: "Checking…" }; draw();
    const r = await PC.send({ type: "helper" });
    ui.helper = r && r.ok ? { ok: true, text: `Installed: version ${r.helper.version} on ${r.helper.os}.` } : { ok: false, code: r && r.code, text: (r && r.error) || "No answer." };
    draw();
  }

  async function act(el) {
    const a = el.dataset.act;
    if (a === "addOAuth") {
      ui.working = el.dataset.kind; note("");
      const r = await PC.send({ type: "addOAuth", kind: el.dataset.kind });
      ui.working = null;
      if (r && r.error && el.dataset.kind === "microsoft" && !S.microsoft.clientId) { ui.open = "microsoft"; note("Outlook needs an app registration first: see Advanced › Outlook sign-in.", true); return; }
      note(r && r.error ? r.error : `Added ${r.account.email}.`, r && r.error);
    } else if (a === "openGoogle") {
      ui.open = "google"; note("Gmail needs your own Google client in this copy: see Advanced › Use your own Google client.", true);
      const d = document.getElementById("google"); if (d) d.scrollIntoView({ block: "start" });
    } else if (a === "reauth") {
      const acct = S.accounts.find((x) => x.id === el.dataset.id);
      ui.working = acct.kind;
      const r = await PC.send({ type: "addOAuth", kind: acct.kind, hint: acct.email });
      ui.working = null;
      note(r && r.error ? r.error : `Signed ${acct.email} in again.`, r && r.error);
    } else if (a === "remove") {
      if (ui.armed !== el.dataset.id) { ui.armed = el.dataset.id; draw(); return; }
      ui.armed = null;
      await PC.send({ type: "remove", id: el.dataset.id });
      note("Removed. Its sign-in and stored codes are gone.");
    } else if (a === "showImap") {
      ui.addImap = true; ui.preset = el.dataset.preset || "icloud"; draw();
      checkHelper();
    } else if (a === "cancelImap") { ui.addImap = false; draw(); }
    else if (a === "openHelper") { ui.open = "helper"; draw(); const d = document.getElementById("helper"); if (d) d.scrollIntoView({ block: "start" }); }
    else if (a === "copyRedirect") { await navigator.clipboard.writeText(redirect); note("Copied the redirect URI."); }
    else if (a === "copyCmd") { await navigator.clipboard.writeText(CMD); note("Copied. Run it in the PocketCodes folder."); }
    else if (a === "helper") await checkHelper();
    else if (a === "pageOn" || a === "pageOff") await setPage(a === "pageOn");
    else if (a === "clear") { await PC.send({ type: "clear" }); note("Cleared."); }
  }

  async function setPage(on) {
    if (on) {
      // the permission prompt needs this click, so ask before anything else is awaited
      const ok = await api.permissions.request({ origins: ["<all_urls>"] });
      if (!ok) { note("Without that permission the chip can't appear. The toolbar's Fill key still works.", true); return; }
      const r = await PC.send({ type: "page", on: true });
      if (r && r.error) { note(r.error, true); return; }
      await PC.store.setSettings({ page: true });
      ui.note = "On. Codes will show up by the box on sign-in pages."; ui.noteBad = false;
    } else {
      await PC.send({ type: "page", on: false });
      await api.permissions.remove({ origins: ["<all_urls>"] }).catch(() => {});
      await PC.store.setSettings({ page: false });
    }
    await load(); draw();
  }

  app.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]");
    if (b) act(b).catch((err) => note(String((err && err.message) || err), true));
  });
  app.addEventListener("toggle", (e) => { if (e.target.tagName === "DETAILS") ui.open = e.target.open ? e.target.id : ui.open === e.target.id ? null : ui.open; }, true);
  app.addEventListener("change", (e) => {
    const t = e.target;
    if (t.name === "preset" && t.form && t.form.dataset.form === "imap") { ui.preset = t.value; draw(); return; }
    if (t.dataset.set) {
      const v = t.type === "checkbox" ? t.checked : t.dataset.num ? Number(t.value) : t.value.trim();
      setPath(t.dataset.set, v).then(() => PC.send({ type: "settings" }).catch(() => {}));
    }
  });
  app.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.dataset.form !== "imap") return;
    const d = Object.fromEntries(new FormData(f));
    ui.working = "imap"; note("");
    const r = await PC.send(Object.assign({ type: "addImap" }, d));
    ui.working = null;
    if (r && r.error) { ui.addImap = true; if (r.code === "no-host") checkHelper(); note(r.error, true); return; }
    ui.addImap = false;
    note(`Added ${r.account.email}.`);
  });

  const typing = () => document.activeElement && /^(INPUT|SELECT)$/.test(document.activeElement.tagName);
  api.storage.onChanged.addListener((ch, area) => {
    if (area !== "local" || ui.working || typing()) return;
    load().then(draw);
  });
  load().then(() => { draw(); if (ui.addImap) checkHelper(); });
  setInterval(() => { if (!ui.working && !typing()) load().then(draw); }, 15000);
})(globalThis);
