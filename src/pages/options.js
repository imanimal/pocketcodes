/* PocketCodes: the settings page (opens in a tab). Reads storage; the background script does every account write, so
   adding, signing in again and removing are messages. The pages write only settings, google and microsoft. */
(function (g) {
  const PC = g.PC;
  const api = PC.api;
  const esc = PC.esc;
  const app = document.getElementById("app");
  const redirect = (() => { try { return api.identity.getRedirectURL(); } catch (e) { return ""; } })();
  let S = { accounts: [], settings: PC.DEFAULTS, google: {}, microsoft: {}, st: {}, meta: {} };
  let ui = { addImap: false, preset: "icloud", note: "", noteBad: false, helper: null, armed: null, working: null };
  const keepOpen = { imap: false };

  async function load() {
    const r = await api.storage.local.get(["accounts", "settings", "google", "microsoft", "meta"]);
    const accounts = r.accounts || [];
    const st = await api.storage.local.get(accounts.map((a) => "st:" + a.id));
    S = { accounts, settings: Object.assign({}, PC.DEFAULTS, r.settings || {}), google: r.google || {}, microsoft: r.microsoft || {}, st, meta: r.meta || {} };
  }

  const stat = (a) => {
    const s = S.st["st:" + a.id];
    if (!s) return `<span class="quiet">Not checked yet</span>`;
    return s.ok ? `<span class="quiet">Checked ${esc(PC.ago(s.at))}</span>` : `<span class="bad">${esc(s.error)}</span>`;
  };

  function acctRow(a) {
    const s = S.st["st:" + a.id];
    const again = s && !s.ok && s.auth ? `<button data-act="reauth" data-id="${esc(a.id)}" class="go">Sign in again</button>` : "";
    const rm = ui.armed === a.id ? `<button data-act="remove" data-id="${esc(a.id)}" class="bad">Remove? Press again</button>` : `<button data-act="remove" data-id="${esc(a.id)}">Remove</button>`;
    return `<div class="acct"><div class="who"><span><span class="tag">${esc(PC.kindLabel(a))}</span><b>${esc(a.email)}</b></span>${stat(a)}</div>
      <div class="row">${again}${rm}</div></div>`;
  }

  function imapForm() {
    const p = PC.imap.presets[ui.preset];
    const custom = ui.preset === "custom";
    return `<form class="box" data-form="imap" autocomplete="off">
      <div class="grid2">
        <label>Provider<select name="preset">${Object.entries(PC.imap.presets).map(([k, v]) => `<option value="${k}" ${k === ui.preset ? "selected" : ""}>${esc(v.label)}</option>`).join("")}</select></label>
        <label>Email address<input type="email" name="email" required autocomplete="off" placeholder="you@icloud.com"></label>
      </div>
      <label>Password<input type="password" name="password" required autocomplete="off" placeholder="App-specific password"></label>
      <p class="quiet">Use ${esc(p.secret)}. ${ui.preset === "icloud" ? "Your Apple ID password won't work. " : ""}It goes straight to the helper, which keeps it in this computer's own vault; this extension never stores it.</p>
      ${custom ? `<div class="grid2"><label>IMAP server<input type="text" name="host" placeholder="imap.example.com"></label><label>Port<input type="number" name="port" value="993"></label></div>
        <label>Username (if it isn't the address)<input type="text" name="user" autocomplete="off"></label>` : ""}
      <div class="row"><button class="go" type="submit" ${ui.working === "imap" ? "disabled" : ""}>${ui.working === "imap" ? "Checking the login…" : "Add account"}</button>
        <button type="button" data-act="cancelImap">Cancel</button></div>
    </form>`;
  }

  function draw() {
    const s = S.settings;
    const g1 = S.google, m1 = S.microsoft;
    const helper = ui.helper;
    const cmd = "python host/install_host.py";
    PC.mount(app, `
      <section id="welcome">
        <h2>Accounts</h2>
        ${S.accounts.length ? S.accounts.map(acctRow).join("") : `<p class="quiet">No accounts yet. Add as many as you like; each one is checked on its own.</p>`}
        <div class="row">
          <button data-act="addOAuth" data-kind="google" ${ui.working === "google" ? "disabled" : ""}>${ui.working === "google" ? "Waiting for Google…" : "Add Gmail"}</button>
          <button data-act="addOAuth" data-kind="microsoft" ${ui.working === "microsoft" ? "disabled" : ""}>${ui.working === "microsoft" ? "Waiting for Microsoft…" : "Add Outlook"}</button>
          <button data-act="showImap">Add iCloud or other IMAP</button>
        </div>
        ${ui.addImap ? imapForm() : ""}
        <p class="status ${ui.noteBad ? "bad" : "good"}" role="status">${esc(ui.note)}</p>
      </section>

      <section id="google">
        <h2>Google sign-in</h2>
        <p class="quiet">Gmail needs an OAuth client of your own, which is free and takes about five minutes. That is also why there is no limit on accounts: nothing is shared with anyone.</p>
        <ol>
          <li>In <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener">Google Cloud</a>, create a project and turn on the <a href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank" rel="noopener">Gmail API</a>.</li>
          <li>Under <b>Google Auth Platform</b> set it up as <b>External</b>. Add the Gmail scope <code>gmail.readonly</code>, and either publish the app (it stays "unverified", which is fine for you) or add each address as a test user. Test mode expires sign-ins after 7 days.</li>
          <li>Under <b>Clients</b> create an OAuth client of type <b>Web application</b> and add this redirect URI:</li>
        </ol>
        <div class="copy"><input type="text" readonly value="${esc(redirect)}" aria-label="Redirect URI"><button data-act="copyRedirect">Copy</button></div>
        <div class="grid2">
          <label>Client ID<input type="text" data-set="google.clientId" value="${esc(g1.clientId || "")}" autocomplete="off" spellcheck="false"></label>
          <label>Client secret<input type="password" data-set="google.clientSecret" value="${esc(g1.clientSecret || "")}" autocomplete="off"></label>
        </div>
        <p class="quiet">Work and school Google accounts (such as ucsb.edu) may be blocked by their admin from third-party apps. If sign-in says access is blocked, forward that account's mail to a Gmail address you can add.</p>
      </section>

      <section id="microsoft">
        <h2>Microsoft sign-in</h2>
        <p class="quiet">Only needed for Outlook, Hotmail or Microsoft 365. Register an app in <a href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noopener">Microsoft Entra</a> with account type <b>Personal and work accounts</b>, add a <b>Mobile and desktop applications</b> platform with this redirect URI, then paste the application (client) ID. This one is untested; the author has no Microsoft account.</p>
        <div class="copy"><input type="text" readonly value="${esc(redirect)}" aria-label="Redirect URI"><button data-act="copyRedirect">Copy</button></div>
        <label>Application (client) ID<input type="text" data-set="microsoft.clientId" value="${esc(m1.clientId || "")}" autocomplete="off" spellcheck="false"></label>
      </section>

      <section id="helper">
        <h2>IMAP helper</h2>
        <p class="quiet">iCloud and other IMAP mailboxes need a small helper program, because a browser extension can't open an IMAP connection. It is one Python file with no dependencies (host/), and it only answers this extension.</p>
        <p>Install it once from the PocketCodes folder, then restart the browser:</p>
        <div class="copy"><input type="text" readonly value="${esc(cmd)}" aria-label="Command"><button data-act="copyCmd">Copy</button></div>
        <div class="row"><button data-act="helper">Check the helper</button>
          <span class="status ${helper && helper.ok ? "good" : "bad"}">${helper ? esc(helper.text) : ""}</span></div>
      </section>

      <section id="settings">
        <h2>Settings</h2>
        <label class="check"><input type="checkbox" data-set="settings.notify" ${s.notify ? "checked" : ""}><span>Show a notification when a new code arrives</span></label>
        <div class="grid2">
          <label>Check every<select data-set="settings.every" data-num="1">${[1, 2, 5].map((n) => `<option value="${n}" ${s.every === n ? "selected" : ""}>${n} minute${n > 1 ? "s" : ""}</option>`).join("")}</select></label>
          <label>A code counts as fresh for<select data-set="settings.fresh" data-num="1">${[5, 10, 15, 30].map((n) => `<option value="${n}" ${s.fresh === n ? "selected" : ""}>${n} minutes</option>`).join("")}</select></label>
        </div>
        <label class="check"><input type="checkbox" data-act="page" ${s.page ? "checked" : ""}><span>Offer codes on sign-in pages<br><span class="quiet">Shows a small chip by a code box with the newest fresh code. This asks for permission to run on all sites; the script only looks at the boxes' own names and sends nothing anywhere.</span></span></label>
        <label ${s.page ? "" : "hidden"}>On those pages<select data-set="settings.fill"><option value="ask" ${s.fill === "ask" ? "selected" : ""}>Show the code and let me press Fill</option><option value="auto" ${s.fill === "auto" ? "selected" : ""}>Fill it as soon as it arrives</option></select></label>
        <p class="quiet">Without that, the toolbar popup's Fill key and <kbd>Alt+Shift+F</kbd> fill the page you're on. Change the shortcuts in your browser's extension shortcuts page.</p>
        <div class="row"><button data-act="clear">Forget the codes found so far</button></div>
      </section>`);
    if (g.location.hash && !draw.scrolled) { draw.scrolled = true; const t = document.querySelector(g.location.hash); if (t) t.scrollIntoView(); }
  }

  const note = (text, bad) => { ui.note = text; ui.noteBad = !!bad; draw(); };

  async function setPath(path, value) {
    const [root, key] = path.split(".");
    if (root === "settings") { await PC.store.setSettings({ [key]: value }); await PC.send({ type: "settings" }).catch(() => {}); }
    else { const cur = await PC.store.get(root, {}); cur[key] = value; await PC.store.set(root, cur); }
  }

  async function act(el) {
    const a = el.dataset.act;
    if (a === "addOAuth") {
      ui.working = el.dataset.kind; note("");
      const r = await PC.send({ type: "addOAuth", kind: el.dataset.kind });
      ui.working = null;
      note(r && r.error ? r.error : `Added ${r.account.email}.`, r && r.error);
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
    } else if (a === "showImap") { ui.addImap = true; draw(); }
    else if (a === "cancelImap") { ui.addImap = false; draw(); }
    else if (a === "copyRedirect") { await navigator.clipboard.writeText(redirect); note("Copied the redirect URI."); }
    else if (a === "copyCmd") { await navigator.clipboard.writeText("python host/install_host.py"); note("Copied. Run it in the PocketCodes folder."); }
    else if (a === "helper") {
      ui.helper = { ok: false, text: "Checking…" }; draw();
      const r = await PC.send({ type: "helper" });
      ui.helper = r && r.ok ? { ok: true, text: `Installed: version ${r.helper.version} on ${r.helper.os}.` } : { ok: false, text: (r && r.error) || "No answer." };
      draw();
    } else if (a === "clear") { await PC.send({ type: "clear" }); note("Cleared."); }
  }

  async function togglePage(box) {
    if (box.checked) {
      // the permission prompt needs this click, so ask before anything else is awaited
      const ok = await api.permissions.request({ origins: ["<all_urls>"] });
      if (!ok) { box.checked = false; note("Without that permission the chip can't appear.", true); return; }
      const r = await PC.send({ type: "page", on: true });
      if (r && r.error) { box.checked = false; note(r.error, true); return; }
      await PC.store.setSettings({ page: true });
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
  app.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.act === "page") { togglePage(t).catch((err) => note(String((err && err.message) || err), true)); return; }
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
    if (r && r.error) { ui.addImap = true; note(r.error + (r.code === "no-host" ? "" : ""), true); return; }
    ui.addImap = false;
    note(`Added ${r.account.email}.`);
  });

  api.storage.onChanged.addListener((ch, area) => {
    if (area !== "local" || ui.working || (document.activeElement && /^(INPUT|SELECT)$/.test(document.activeElement.tagName))) return;
    load().then(draw);
  });
  load().then(draw);
  setInterval(() => { if (!ui.working && !(document.activeElement && /^(INPUT|SELECT)$/.test(document.activeElement.tagName))) load().then(draw); }, 15000);
})(globalThis);
