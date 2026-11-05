/* PocketCodes: the settings page (opens in a tab, and on install). Reads storage; the background script does every
   account write, so adding, signing in again and removing are messages. The pages write only settings, google and
   microsoft. It leads with three steps (add inboxes, turn on codes on sign-in pages, the fill key); your own Google
   client, Outlook and the IMAP helper's details sit under Advanced. "Texts and authenticator apps" adds authenticator
   keys (straight to the helper's vault) and the two free ways for texts to reach PocketCodes. #welcome, #icloud,
   #helper and #more jump to their part. */
(function (g) {
  const PC = g.PC;
  const api = PC.api;
  const esc = PC.esc;
  const app = document.getElementById("app");
  const redirect = (() => { try { return api.identity.getRedirectURL(); } catch (e) { return ""; } })();
  // the built-in Google client (client.js) works only where Firefox's loopback redirect does
  const builtIn = !!(PC.CLIENT && PC.CLIENT.google.id && PC.CLIENT.google.secret && /\.extensions\.allizom\.org\//.test(redirect));
  const CMD = "python host/install_host.py";
  let S = { accounts: [], settings: PC.DEFAULTS, google: {}, microsoft: {}, st: {}, meta: {}, codes: [], auth: [] };
  let ui = { addImap: g.location.hash === "#icloud", preset: "icloud", note: "", noteBad: false, helper: null, armed: null, working: null, open: g.location.hash === "#helper" ? "helper" : null };

  /** Whether the browser still lets the sign-in page script run (you can take its site access away in the add-ons page). */
  const siteAccess = () => (api.permissions && api.permissions.contains ? api.permissions.contains({ origins: ["<all_urls>"] }).catch(() => true) : Promise.resolve(true));

  async function load() {
    const r = await api.storage.local.get(["accounts", "settings", "google", "microsoft", "meta", "codes", "authenticators"]);
    const accounts = r.accounts || [];
    const st = await api.storage.local.get(accounts.map((a) => "st:" + a.id));
    S = { accounts, settings: Object.assign({}, PC.DEFAULTS, r.settings || {}), google: r.google || {}, microsoft: r.microsoft || {}, st, meta: r.meta || {}, codes: r.codes || [], auth: r.authenticators || [], access: await siteAccess() };
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
  const helperSteps = () => `<p>iCloud and other IMAP inboxes, authenticator codes and texts go through a small helper program, because an extension can't open an IMAP connection or reach this computer's vault.
      It's one Python file with no dependencies, and it only answers PocketCodes. Install it once from the PocketCodes folder (again after an update), then restart Firefox:</p>
    <div class="copy"><input type="text" readonly value="${esc(CMD)}" aria-label="Command"><button data-act="copyCmd">Copy</button></div>`;

  function totpRow(t) {
    const rm = ui.armed === t.id ? `<button data-act="removeTotp" data-id="${esc(t.id)}" class="bad sm">Remove? Press again</button>` : `<button data-act="removeTotp" data-id="${esc(t.id)}" class="sm">Remove</button>`;
    return `<div class="acct box"><div class="who"><span><span class="tag">Authenticator</span><b>${esc(t.name)}</b></span><span class="quiet">${esc(t.site)}${t.label ? " · " + esc(t.label) : ""}</span></div>
      <div class="row">${rm}</div></div>`;
  }

  function totpForm() {
    const h = ui.helper;
    const missing = h && !h.ok && (h.code === "no-host" || h.code === "old-host");
    return `<form class="box" data-form="totp" autocomplete="off">
      ${missing ? `<div class="box">${helperSteps()}${helperLine()}</div>` : ""}
      <div class="grid2">
        <label>Site<input type="text" name="site" required placeholder="github.com" spellcheck="false"></label>
        <label>Name (optional)<input type="text" name="name" placeholder="GitHub"></label>
      </div>
      <label>Key, or the otpauth:// link<input type="password" name="key" required autocomplete="off" spellcheck="false" placeholder="JBSW Y3DP EHPK 3PXP"></label>
      <p class="quiet">When you turn on two-factor sign-in, the site shows a QR code: choose its <b>Can't scan it?</b> or <b>Enter a key</b> link and paste that key here. It goes straight to the helper, which keeps it in this computer's own vault; PocketCodes only ever sees the codes. Add it to your phone's authenticator too, so you aren't locked out away from this computer.</p>
      <div class="row"><button class="go" type="submit" ${ui.working === "totp" ? "disabled" : ""}>${ui.working === "totp" ? "Checking the key…" : "Add authenticator"}</button>
        <button type="button" data-act="cancelTotp">Cancel</button></div>
    </form>`;
  }

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
    const pageOn = s.page && S.access;
    const g1 = S.google, m1 = S.microsoft;
    const now = Date.now();
    const top = S.codes.find((c) => !c.used && now - c.at < s.fresh * PC.MIN);
    const n = S.accounts.filter((a) => a.kind !== "texts").length;
    const texts = S.accounts.some((a) => a.kind === "texts");
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
              ${S.accounts.length ? S.accounts.map(acctRow).join("") : ""}
            </div></div>
          <div class="step"><span class="n ${pageOn ? "done" : ""}">2</span><h3>Codes pop up on sign-in pages</h3>
            <div class="body">
              <p>When a page asks for a code, a small chip pops up by the box: it checks your inboxes every few seconds and shows the code the moment it lands. It only looks at code boxes and the form around them, and sends nothing anywhere.</p>
              <div class="row">${pageOn
                ? `<span class="good"><b>On.</b></span><span class="quiet">When a code arrives:</span><select data-set="settings.fill" aria-label="When a code arrives"><option value="ask" ${s.fill === "ask" ? "selected" : ""}>Show it, I press Fill</option><option value="auto" ${s.fill === "auto" ? "selected" : ""}>Fill it in for me</option></select><button data-act="pageOff" class="sm">Turn off</button>`
                : s.page
                  ? `<span class="bad">Firefox has PocketCodes' access to sites turned off, so the chip can't appear.</span><button data-act="pageOn" class="go">Allow</button>`
                  : `<span class="quiet"><b>Off.</b></span><button data-act="pageOn" class="go">Turn on</button>`}</div>
            </div></div>
          <div class="step"><span class="n done">3</span><h3>Fill with one key</h3>
            <div class="body"><p>On any page, <kbd>Alt+Shift+F</kbd> fills the newest code, and <kbd>Alt+Shift+C</kbd> opens the list. The toolbar button's <b>Fill</b> does the same.</p></div></div>
        </div>
      </section>

      <section class="panel card" id="more">
        <div class="band"><span class="label">Texts and authenticator apps</span></div>
        <div class="in steps">
          <div class="step"><span class="n ${S.auth.length ? "done" : ""}">A</span><h3>Authenticator codes</h3>
            <div class="body">
              <p>For sites that ask for the code in an authenticator app. Add a site's key once and its code shows by the box, and in the toolbar list, with no phone needed. Free, through the same helper as iCloud.</p>
              <p class="status ${ui.moreBad ? "bad" : "good"}" role="status">${esc(ui.moreNote || "")}</p>
              ${ui.addTotp ? totpForm() : `<div class="row"><button data-act="showTotp" class="go">Add an authenticator</button></div>`}
              ${S.auth.map(totpRow).join("")}
              <p class="quiet">With an authenticator on this computer, someone who gets into it has both your password and your code. That's the trade for the convenience; leave out the accounts that matter most.</p>
            </div></div>
          <div class="step"><span class="n ${texts || s.forward ? "done" : ""}">B</span><h3>Codes sent by text</h3>
            <div class="body">
              <p>When a page says it texted your phone, the chip stays away unless your texts reach PocketCodes. Two free ways:</p>
              <h4>On a Mac, with an iPhone</h4>
              <p class="quiet">Turn on <b>Text Message Forwarding</b> for this Mac on the iPhone (Settings › Apps › Messages), so texts land in the Mac's Messages app. Then give your browser <b>Full Disk Access</b> (System Settings › Privacy &amp; Security), restart it, and PocketCodes reads new texts through the helper, read-only.</p>
              <div class="row">${texts ? `<span class="good"><b>Reading texts on this Mac.</b></span>` : `<button data-act="addTexts" ${ui.working === "texts" ? "disabled" : ""}>${ui.working === "texts" ? "Checking Messages…" : "Read texts on this Mac"}</button>`}</div>
              <h4>Anywhere else: forward them to an inbox</h4>
              <p class="quiet">iPhone: in the Shortcuts app, Automation › New › <b>Message</b>, Message Contains <code>code</code>, Run Immediately; the action is <b>Send Email</b> to one of the inboxes above, subject <code>${esc(PC.texts.FORWARD_SUBJECT)}</code>, body the Shortcut Input. Android: any free SMS-forwarding app, sending to one of those inboxes with that subject.</p>
              <label class="check"><input type="checkbox" data-set="settings.forward" ${s.forward ? "checked" : ""}><span>My phone forwards texts to one of my inboxes</span></label>
            </div></div>
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
          <details id="helper" ${ui.open === "helper" ? "open" : ""}><summary>The helper (iCloud, IMAP, authenticators, texts)</summary><div class="in">${helperSteps()}${helperLine()}</div></details>
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
    ui.helper = r && r.ok
      ? r.helper.totp ? { ok: true, text: `Installed: version ${r.helper.version} on ${r.helper.os}.` }
        : { ok: false, code: "old-host", text: `Installed, but version ${r.helper.version} is too old for authenticators and texts: run the command again, then restart Firefox.` }
      : { ok: false, code: r && r.code, text: (r && r.error) || "No answer." };
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
    else if (a === "showTotp") { ui.addTotp = true; draw(); checkHelper(); }
    else if (a === "cancelTotp") { ui.addTotp = false; draw(); }
    else if (a === "removeTotp") {
      if (ui.armed !== el.dataset.id) { ui.armed = el.dataset.id; draw(); return; }
      ui.armed = null;
      await PC.send({ type: "removeTotp", id: el.dataset.id });
      ui.moreNote = "Removed, and the helper forgot its key."; ui.moreBad = false;
      await load(); draw();
    } else if (a === "addTexts") {
      ui.working = "texts"; draw();
      const r = await PC.send({ type: "addTexts" });
      ui.working = null;
      ui.moreNote = r && r.error ? r.error : "Reading texts on this Mac."; ui.moreBad = !!(r && r.error);
      if (r && (r.code === "no-host" || r.code === "old-host")) ui.open = "helper";
      await load(); draw();
    }
  }

  async function setPage(on) {
    // the access prompt needs this click, so ask before anything else is awaited
    if (on && !S.access && !(await api.permissions.request({ origins: ["<all_urls>"] }))) {
      note("Without access to sites the chip can't appear. The toolbar's Fill key still works.", true);
      return;
    }
    const r = await PC.send({ type: "page", on });
    if (r && r.error) { note(r.error, true); return; }
    ui.note = on ? "On. Codes pop up by the box on sign-in pages." : ""; ui.noteBad = false;
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
    if (f.dataset.form === "totp") {
      const t = Object.fromEntries(new FormData(f));
      ui.working = "totp"; draw();
      const r = await PC.send(Object.assign({ type: "addTotp" }, t));
      ui.working = null;
      if (r && r.error) { if (r.code === "no-host" || r.code === "old-host") checkHelper(); ui.moreNote = r.error; ui.moreBad = true; draw(); return; }
      ui.addTotp = false; ui.moreNote = `Added ${r.entry.name}: its code right now is ${PC.group(r.code)}.`; ui.moreBad = false;
      await load(); draw();
      return;
    }
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
