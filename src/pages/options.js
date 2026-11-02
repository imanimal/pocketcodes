/* AuthSkip: the settings page (opens in a tab). Sections: Accounts, Gmail, Outlook, iCloud and IMAP (the helper),
   Checking, Look (ui/look.js) and Data. Reads storage; the background script does every account write, so adding,
   signing in again and removing are messages. The page writes only settings, themes, google and microsoft.
   Painted in the theme it sets; #welcome (opened once, on install) adds the three things to know first, and any other
   hash scrolls to that section. */
(function (g) {
  const AS = g.AS, api = AS.api, T = AS.themes, K = AS.kit, esc = AS.esc;
  const panel = document.getElementById("panel"), root = document.documentElement;
  const redirect = (() => { try { return api.identity.getRedirectURL(); } catch (e) { return ""; } })();
  const CMD = "python host/install_host.py";
  const SECTIONS = [["accounts", "Accounts"], ["gmail", "Gmail"], ["outlook", "Outlook"], ["helper", "iCloud and IMAP"], ["checking", "Checking"], ["look", "Look"], ["data", "Data"]];
  let S = { accounts: [], settings: AS.DEFAULTS, themes: [], google: {}, microsoft: {}, st: {} };
  const ui = { imap: null, note: "", noteBad: false, helper: null, working: null };
  const look = AS.look.panel({ settings: () => S.settings, mine: () => S.themes, render: () => render() });
  // icons in the look the page is about to show
  const ic = (n, c) => AS.ic(n, c, AS.previewing ? root.dataset.asLook : T.pick(S.settings, T.BUILTIN.concat(S.themes)).look);

  async function load() {
    const r = await api.storage.local.get(["accounts", "settings", "themes", "google", "microsoft"]);
    const accounts = r.accounts || [];
    const st = accounts.length ? await api.storage.local.get(accounts.map((a) => "st:" + a.id)) : {};
    S = { accounts, settings: Object.assign({}, AS.DEFAULTS, r.settings || {}), themes: r.themes || [], google: r.google || {}, microsoft: r.microsoft || {}, st };
  }
  function paint() { if (!AS.previewing) T.look(S.settings, T.BUILTIN.concat(S.themes), root); }

  // ── parts ──
  const sec = (id, icon, title, lead, body) => `<section class="as-sec" id="as-s-${id}"><h3>${ic(icon)}${esc(title)}</h3>${lead ? `<p class="as-lead">${esc(lead)}</p>` : ""}${body}</section>`;
  const chips = (name, value, opts, label) => `<div class="as-seg" role="radiogroup" aria-label="${esc(label)}">${opts.map(([v, l]) =>
    `<button type="button" class="as-chip${v === value ? " on" : ""}" role="radio" aria-checked="${v === value}" data-act="set" data-set="${name}" data-v="${esc(v)}" data-k="set-${name}-${esc(v)}">${esc(l)}</button>`).join("")}</div>`;
  const pickOpt = (title, desc, body) => `<div class="as-opt col"><div><b>${esc(title)}</b>${desc ? `<span class="as-od">${esc(desc)}</span>` : ""}</div>${body}</div>`;
  const sw = (title, desc, attrs) => `<label class="as-opt"><div><b>${esc(title)}</b><span class="as-od">${esc(desc)}</span></div><input type="checkbox" class="as-switch" ${attrs}></label>`;
  const copyRow = (value, label) => `<div class="op-copy"><input type="text" readonly value="${esc(value)}" aria-label="${esc(label)}">${K.key({ icon: "copy", label: "Copy", cls: "sm", act: "copy", attrs: `data-v="${esc(value)}"` })}</div>`;
  const field = (label, attrs, hint) => `<label class="op-field">${esc(label)}<input ${attrs}>${hint ? `<span>${esc(hint)}</span>` : ""}</label>`;
  const note = () => (ui.note ? `<p class="as-note${ui.noteBad ? " bad" : ""}" role="status">${esc(ui.note)}</p>` : "");

  function accounts() {
    const rows = S.accounts.map((a) => {
      const s = S.st["st:" + a.id];
      const state = !s ? `<span class="as-od">${esc(AS.kindLabel(a))} · Not checked yet</span>`
        : s.ok ? `<span class="as-od">${esc(AS.kindLabel(a))} · Checked ${esc(AS.ago(s.at))}</span>`
        : `<span class="as-od bad">${esc(AS.kindLabel(a))} · ${esc(s.error)}</span>`;
      const again = s && !s.ok && s.auth
        ? a.kind === "imap" ? K.key({ label: "Add again", cls: "sm primary", act: "imapAgain", id: a.id }) : K.key({ label: "Sign in again", cls: "sm primary", act: "reauth", id: a.id, disabled: !!ui.working })
        : "";
      return `<div class="as-opt op-acct"><div><b>${esc(a.email)}</b>${state}</div><div class="as-row2">${again}${K.key({ label: "Remove", cls: "sm", act: "remove", id: a.id })}</div></div>`;
    }).join("");
    const wait = (kind, label, busy) => (ui.working === kind ? busy : label);
    const adds = `<div class="as-row2" style="padding:12px 0 4px">
      ${K.key({ label: wait("google", "Add Gmail", "Waiting for Google…"), icon: "plus", act: "addOAuth", attrs: 'data-kind="google"', disabled: !!ui.working })}
      ${K.key({ label: wait("microsoft", "Add Outlook", "Waiting for Microsoft…"), icon: "plus", act: "addOAuth", attrs: 'data-kind="microsoft"', disabled: !!ui.working })}
      ${K.key({ label: "Add iCloud or IMAP", icon: "plus", act: "showImap", disabled: !!ui.working })}</div>`;
    return sec("accounts", "person", "Accounts", "Add as many as you like. Each one is checked on its own, read-only.",
      (rows || '<p class="as-note" style="padding:8px 0">No accounts yet.</p>') + adds + (ui.imap ? imapForm() : "") + note());
  }

  function imapForm() {
    const f = ui.imap, p = AS.imap.presets[f.preset] || AS.imap.presets.custom, custom = f.preset === "custom";
    return `<form class="as-mod op-form" data-form="imap" autocomplete="off">
      <div class="as-band"><span class="as-bt">${ic("mail")}Add an iCloud or IMAP account</span><span class="as-sp"></span>${K.key({ icon: "close", title: "Cancel", cls: "ghost sm", act: "cancelImap" })}</div>
      <div class="as-mb">
        <div class="op-grid2">
          <label class="op-field">Provider<select name="preset" data-k="preset">${Object.entries(AS.imap.presets).map(([k, v]) => `<option value="${k}"${k === f.preset ? " selected" : ""}>${esc(v.label)}</option>`).join("")}</select></label>
          ${field("Email address", `type="email" name="email" required autocomplete="off" placeholder="you@icloud.com" value="${esc(f.email || "")}" data-k="email"`)}
        </div>
        ${field("Password", 'type="password" name="password" required autocomplete="off" placeholder="App-specific password" data-k="password"', `Use ${p.secret}.${f.preset === "icloud" ? " Your Apple Account password won't work." : ""} It goes straight to the helper, which keeps it in this computer's own vault; the extension never stores it.`)}
        ${custom ? `<div class="op-grid2">${field("IMAP server", `type="text" name="host" placeholder="imap.example.com" value="${esc(f.host || "")}"`)}${field("Port", `type="number" name="port" value="${esc(f.port || 993)}"`)}</div>
          ${field("Username, if it isn't the address", `type="text" name="user" autocomplete="off" value="${esc(f.user || "")}"`)}` : ""}
        <div class="as-row2"><button type="submit" class="as-key primary"${ui.working === "imap" ? " disabled" : ""}><span class="as-kl">${ui.working === "imap" ? "Checking the login…" : "Add account"}</span></button>${K.key({ label: "Cancel", act: "cancelImap" })}</div>
      </div></form>`;
  }

  function gmail() {
    const c = S.google;
    return sec("gmail", "lock", "Gmail", "Gmail needs a sign-in client of your own. It's free, takes about five minutes, and nothing is shared with anyone, which is also why there's no limit on accounts.",
      `<ol class="op-steps">
        <li>In <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener">Google Cloud</a>, create a project and turn on the <a href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank" rel="noopener">Gmail API</a>.</li>
        <li>Under <b>Google Auth Platform</b>, choose audience <b>External</b> and add the scope <code>gmail.readonly</code>. Publish the app (it stays unverified, which is fine for you), or add each address as a test user. Test mode ends sign-ins after 7 days.</li>
        <li>Under <b>Clients</b>, create a <b>Web application</b> client with this redirect URI:</li>
      </ol>
      ${copyRow(redirect, "Redirect URI")}
      <div class="op-grid2" style="margin-top:12px">${field("Client ID", `type="text" data-store="google.clientId" value="${esc(c.clientId || "")}" autocomplete="off" spellcheck="false" data-k="gid"`)}${field("Client secret", `type="password" data-store="google.clientSecret" value="${esc(c.clientSecret || "")}" autocomplete="off" data-k="gsecret"`)}</div>
      <p class="as-note" style="padding-top:10px">Work and school Google accounts can be blocked from apps like this by their admin. If sign-in says access is blocked, forward that account's mail to a Gmail address you can add.</p>`);
  }

  function outlook() {
    return sec("outlook", "lock", "Outlook", "Only for Outlook, Hotmail or Microsoft 365. Untested so far: written to Microsoft's documentation, without a real account to try.",
      `<ol class="op-steps">
        <li>Register an app in <a href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noopener">Microsoft Entra</a> for <b>personal and work accounts</b>.</li>
        <li>Add a <b>Mobile and desktop applications</b> platform with this redirect URI, and allow public client flows:</li>
      </ol>
      ${copyRow(redirect, "Redirect URI")}
      <div style="margin-top:12px">${field("Application (client) ID", `type="text" data-store="microsoft.clientId" value="${esc(S.microsoft.clientId || "")}" autocomplete="off" spellcheck="false" data-k="mid"`)}</div>`);
  }

  function helper() {
    const h = ui.helper;
    return sec("helper", "mail", "iCloud and IMAP", "A browser extension can't open an IMAP connection, so a small helper does it: one Python file with no dependencies, in the extension's host folder. It only answers AuthSkip, and it keeps passwords in your computer's own vault.",
      `<div class="as-opt col"><div><b>Install it once</b><span class="as-od">Run this in the extension's folder, then restart the browser. Run it again after an update.</span></div>${copyRow(CMD, "Command")}</div>
      <div class="as-opt"><div><b>Check the helper</b><span class="as-od" role="status"${h && !h.ok ? ' style="color:var(--as-bad)"' : ""}>${esc(h ? h.text : "Asks the helper which version is installed.")}</span></div>${K.key({ label: "Check", cls: "sm", act: "helper" })}</div>`);
  }

  function checking() {
    const s = S.settings;
    return sec("checking", "clock", "Checking and filling", "",
      sw("Notify me of new codes", "A notification when a code arrives.", `data-set="notify" data-k="sw-notify"${s.notify ? " checked" : ""}`)
      + pickOpt("Check every", "Every inbox, while the browser is open. The popup and sign-in pages check every few seconds.", chips("every", String(s.every), [["1", "Minute"], ["2", "2 minutes"], ["5", "5 minutes"]], "Check every"))
      + pickOpt("A code counts as fresh for", "Fresh codes are counted on the toolbar button and offered for filling.", chips("fresh", String(s.fresh), [["5", "5 minutes"], ["10", "10 minutes"], ["15", "15 minutes"], ["30", "30 minutes"]], "Fresh for"))
      + sw("Offer codes on sign-in pages", "A small card by a code box with the newest fresh code. This asks to run on all sites; it only looks at the boxes' own names and sends nothing anywhere.", `data-act="page" data-k="sw-page"${s.page ? " checked" : ""}`)
      + (s.page ? pickOpt("On those pages", "", chips("fill", s.fill, [["ask", "Show the code, I press Fill"], ["auto", "Fill it as soon as it arrives"]], "On those pages")) : "")
      + `<p class="as-note" style="padding:8px 0 12px">Without that, Fill in the popup and <kbd>Alt+Shift+F</kbd> fill the page you're on. Change the keys in your browser's extension shortcuts page.</p>`);
  }

  function data() {
    const ver = api.runtime.getManifest ? api.runtime.getManifest().version : "";
    return sec("data", "trash", "Data", "Codes are kept for a day, with the sender's name and the subject; message bodies are read and dropped. Everything stays in this browser.",
      `<div class="as-opt"><div><b>Forget the codes found so far</b><span class="as-od">Accounts and settings stay.</span></div>${K.key({ label: "Forget codes", cls: "sm", act: "clear" })}</div>
      <p class="as-note" style="padding-top:12px">AuthSkip ${esc(ver)}.</p>`);
  }

  function render() {
    const f = document.activeElement, k = f && panel.contains(f) ? f.dataset.k : null;
    panel.replaceChildren(AS.frag(`<nav class="as-set-nav" aria-label="Settings sections">${SECTIONS.map(([id, l]) => `<button type="button" class="as-chip" data-act="jump" data-id="${id}">${l}</button>`).join("")}</nav>
      <div class="as-set">${accounts()}${gmail()}${outlook()}${helper()}${checking()}${sec("look", "palette", "Look", "Pick a theme for the day and one for night. Standard is plain; Pocket themes are the handheld look from Collegiapp.", look.html())}${data()}</div>`));
    if (k) { const n = panel.querySelector(`[data-k="${CSS.escape(k)}"]`); if (n) n.focus({ preventScroll: true }); }
  }
  const say = (text, bad) => { ui.note = text; ui.noteBad = !!bad; render(); };
  const jump = (id) => { const s = panel.querySelector(`#as-s-${id}`); if (s) s.scrollIntoView({ block: "start" }); };

  // ── actions ──
  async function act(b) {
    const a = b.dataset.act, id = b.dataset.id;
    if (a === "jump") jump(id);
    else if (a === "set") { await AS.store.setSettings({ [b.dataset.set]: /^\d+$/.test(b.dataset.v) ? Number(b.dataset.v) : b.dataset.v }); await AS.send({ type: "settings" }).catch(() => {}); }
    else if (a === "copy") { try { await navigator.clipboard.writeText(b.dataset.v); K.toast("Copied"); } catch (e) { K.toast("Couldn't copy here. Select it and press Ctrl+C."); } }
    else if (a === "addOAuth") {
      ui.working = b.dataset.kind; say("");
      const r = await AS.send({ type: "addOAuth", kind: b.dataset.kind });
      ui.working = null;
      say(r && r.error ? r.error : `Added ${r.account.email}.`, r && r.error);
    } else if (a === "reauth") {
      const acct = S.accounts.find((x) => x.id === id);
      ui.working = acct.kind; render();
      const r = await AS.send({ type: "addOAuth", kind: acct.kind, hint: acct.email });
      ui.working = null;
      say(r && r.error ? r.error : `Signed ${acct.email} in again.`, r && r.error);
    } else if (a === "remove") {
      K.twice(b, "Remove?", async () => { await AS.send({ type: "remove", id }); say("Removed. Its sign-in and codes are gone."); });
    } else if (a === "showImap") { ui.imap = { preset: "icloud" }; render(); }
    else if (a === "imapAgain") {
      const acct = S.accounts.find((x) => x.id === id);
      const preset = Object.keys(AS.imap.presets).find((k) => AS.imap.presets[k].host === acct.host) || "custom";
      ui.imap = { preset, email: acct.email, host: acct.host, port: acct.port, user: acct.user !== acct.email ? acct.user : "" };
      render(); jump("accounts");
    } else if (a === "cancelImap") { ui.imap = null; render(); }
    else if (a === "helper") {
      ui.helper = { ok: true, text: "Checking…" }; render();
      const r = await AS.send({ type: "helper" });
      ui.helper = r && r.ok ? { ok: true, text: `Installed: version ${r.helper.version} on ${r.helper.os}.` } : { ok: false, text: (r && r.error) || "No answer." };
      render();
    } else if (a === "clear") K.twice(b, "Forget them?", async () => { await AS.send({ type: "clear" }); K.toast("Forgot the codes"); });
  }

  async function togglePage(box) {
    if (box.checked) {
      // the permission prompt needs this click, so ask before anything else is awaited
      const ok = await api.permissions.request({ origins: ["<all_urls>"] });
      if (!ok) { box.checked = false; K.toast("Without that permission the card can't appear."); return; }
      const r = await AS.send({ type: "page", on: true });
      if (r && r.error) { box.checked = false; K.toast(r.error); return; }
      await AS.store.setSettings({ page: true });
    } else {
      await AS.send({ type: "page", on: false });
      await api.permissions.remove({ origins: ["<all_urls>"] }).catch(() => {});
      await AS.store.setSettings({ page: false });
    }
  }

  async function store(path, value) {
    const [key, name] = path.split(".");
    const cur = await AS.store.get(key, {});
    cur[name] = value;
    await AS.store.set(key, cur);
  }

  const fail = (err) => { ui.working = null; say(String((err && err.message) || err), true); };
  panel.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b || b.tagName === "INPUT") return;
    if (look.click(b)) return;
    act(b).catch(fail);
  });
  panel.addEventListener("change", (e) => {
    const t = e.target;
    if (look.change(t)) return;
    if (t.dataset.act === "page") togglePage(t).catch(fail);
    else if (t.matches("input.as-switch[data-set]")) AS.store.setSettings({ [t.dataset.set]: t.checked });
    else if (t.dataset.store) store(t.dataset.store, t.value.trim());
    else if (t.name === "preset" && ui.imap) {
      const d = Object.fromEntries(new FormData(t.form));
      ui.imap = { preset: t.value, email: d.email, host: d.host, port: d.port, user: d.user };
      render();
    }
  });
  panel.addEventListener("input", (e) => { look.input(e.target); });
  panel.addEventListener("keydown", (e) => { look.key(e); });
  panel.addEventListener("toggle", (e) => look.toggle(e), true);
  panel.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.dataset.form !== "imap") return;
    const d = Object.fromEntries(new FormData(f));
    ui.imap = Object.assign({}, ui.imap, { email: d.email, host: d.host, port: d.port, user: d.user });
    ui.working = "imap"; ui.note = ""; render();
    const r = await AS.send(Object.assign({ type: "addImap" }, d)).catch((err) => ({ error: String((err && err.message) || err) }));
    ui.working = null;
    if (r && r.error) { say(r.error, true); return; }
    ui.imap = null;
    say(`Added ${r.account.email}.`);
  });

  // The background writes storage every minute; a repaint waits while you're typing, filling in the IMAP form or
  // adjusting colors, so it never wipes what you've typed. Your own settings and themes changes always repaint.
  const typing = () => !!ui.imap || look.busy() || (document.activeElement && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName) && document.activeElement.type !== "checkbox");
  api.storage.onChanged.addListener((ch, area) => {
    if (area !== "local") return;
    load().then(() => { paint(); if (ch.settings || ch.themes || !typing()) render(); });
  });
  if (g.matchMedia) g.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { paint(); render(); });

  load().then(() => {
    paint();
    render();
    const h = g.location.hash.slice(1);
    if (h === "welcome") document.getElementById("welcome").hidden = false;
    else if (h) jump(h);
  });
})(globalThis);
