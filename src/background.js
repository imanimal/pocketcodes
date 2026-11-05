/* PocketCodes: the background script. Firefox runs it as an event page after the manifest's script list, Chrome as the
   service worker, which has to load the same libraries itself (importScripts, which Firefox's page doesn't have).
   It owns every write to the accounts, tokens, codes and statuses; the popup, the options page and the sign-in page
   script (on every page, from the manifest) only read storage and send it messages (below). A check runs on the alarm
   (settings.every minutes), at startup, on "Check now", and every few seconds while a popup is open or a page is waiting for a code. */
if (typeof importScripts === "function") {
  importScripts("lib/util.js", "lib/client.js", "lib/codes.js", "lib/google.js", "lib/microsoft.js", "lib/imap.js", "lib/texts.js", "lib/inbox.js");
}
(function (g) {
  const PC = g.PC;
  const api = PC.api;
  const ALARM = "pocketcodes-poll";
  const OLD_PAGE_SCRIPT = "pocketcodes-offer";

  async function schedule() {
    const s = await PC.store.settings();
    const every = Math.max(1, Number(s.every) || 1);
    const cur = await api.alarms.get(ALARM);
    if (!cur || cur.periodInMinutes !== every) await api.alarms.create(ALARM, { delayInMinutes: 0.2, periodInMinutes: every });
  }

  /** Takes the sign-in page script that 0.2.0 registered by hand off again: the manifest runs it on every page now. */
  async function dropOldScript() {
    if (!api.scripting.getRegisteredContentScripts) return;
    const old = await api.scripting.getRegisteredContentScripts({ ids: [OLD_PAGE_SCRIPT] });
    if (old.length) await api.scripting.unregisterContentScripts({ ids: [OLD_PAGE_SCRIPT] });
  }

  /** Settings from before 0.2.1 kept the chip off until you turned it on; it's on for everyone now (and has a switch). */
  async function migrate() {
    const s = await PC.store.get("settings");
    if (s && (Number(s.v) || 1) < 2) await PC.store.setSettings({ v: 2, page: true });
  }

  /** The chip on sign-in pages, on or off. On needs the all-sites access the manifest asks for at install. */
  async function setPage(on) {
    if (on && !(await api.permissions.contains({ origins: ["<all_urls>"] }))) return { error: "PocketCodes doesn't have access to all sites.", code: "no-access" };
    await PC.store.setSettings({ page: on });
    return { ok: true };
  }

  /** Fills a code (default: the newest fresh one; `totp`: that authenticator's code now) into the active tab's code boxes. */
  async function fillTab(tabId, id, totp) {
    let c;
    if (totp) {
      const [t] = await PC.inbox.totpCodes({ id: totp });
      if (!t || !t.code) return { ok: false, reason: (t && t.error) || "That authenticator is gone." };
      c = { code: t.code };
    } else {
      const codes = await PC.store.get("codes", []);
      c = id ? codes.find((x) => x.id === id) : await PC.inbox.newest(codes);
    }
    if (!c) return { ok: false, reason: "No fresh code to fill." };
    if (tabId == null) {
      const [tab] = await api.tabs.query({ active: true, currentWindow: true });
      tabId = tab && tab.id;
    }
    if (tabId == null) return { ok: false, reason: "No page to fill." };
    let results;
    try {
      await api.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["src/lib/util.js", "src/content/fill.js"] });
      results = await api.scripting.executeScript({ target: { tabId, allFrames: true }, func: (code) => !!(globalThis.PC && globalThis.PC.fill && globalThis.PC.fill.fill(code)), args: [c.code] });
    } catch (e) {
      return { ok: false, reason: "This page doesn't let extensions in." };
    }
    if (!results.some((r) => r && r.result)) return { ok: false, reason: "No code box on this page.", code: c.code };
    if (c.id) await PC.inbox.mark("used", [c.id]);
    return { ok: true, code: c.code };
  }

  const handlers = {
    poll: (m) => PC.inbox.poll({ fast: !!m.fast, force: !!m.force, only: m.only }).then(() => ({ ok: true })),
    addOAuth: (m) => PC.inbox.addOAuth(m.kind, m.hint).then((a) => ({ ok: true, account: a })),
    addImap: (m) => PC.inbox.addImap(m).then((a) => ({ ok: true, account: a })),
    remove: (m) => PC.inbox.removeAccount(m.id).then(() => ({ ok: true })),
    seen: () => PC.inbox.mark("seen", "all").then(() => ({ ok: true })),
    used: (m) => PC.inbox.mark("used", [m.id]).then(() => ({ ok: true })),
    fill: (m) => fillTab(m.tabId, m.id, m.totp),
    addTexts: () => PC.inbox.addTexts().then((a) => ({ ok: true, account: a })),
    addTotp: (m) => PC.inbox.addTotp(m).then((r) => Object.assign({ ok: true }, r)),
    removeTotp: (m) => PC.inbox.removeTotp(m.id).then(() => ({ ok: true })),
    // a sign-in page gets only its own site's authenticator codes (the frame's address, not what it says); the
    // popup and settings ask by id, or for all
    totp: (m, page) => PC.inbox.totpCodes(page ? { host: new URL(page).hostname } : { id: m.id }).then((codes) => ({ ok: true, codes })),
    page: (m) => setPage(!!m.on),
    helper: () => PC.imap.status().then((r) => ({ ok: true, helper: r })),
    clear: () => PC.mutex("codes", () => PC.store.set("codes", [])).then(() => PC.inbox.badge()).then(() => ({ ok: true })),
    settings: () => schedule().then(() => PC.inbox.badge()).then(() => ({ ok: true })),
  };

  // what the sign-in page script may ask for; the rest is for the extension's own pages
  const FROM_PAGES = ["poll", "used", "totp"];
  const ours = api.runtime.getURL("");

  // Chrome ignores a returned Promise, so answer with sendResponse and say so with `return true`.
  api.runtime.onMessage.addListener((m, sender, sendResponse) => {
    const h = m && handlers[m.type];
    if (!h) return false;
    const page = sender && sender.url && !sender.url.startsWith(ours) ? sender.url : null;
    if (page && !FROM_PAGES.includes(m.type)) return false;
    h(m, page).then(sendResponse, (e) => sendResponse({ error: String((e && e.message) || e), auth: !!(e && e.auth), code: e && e.code }));
    return true;
  });

  api.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) PC.inbox.poll({}).catch(() => {}); });
  api.commands.onCommand.addListener((cmd) => { if (cmd === "fill-code") fillTab(null).catch(() => {}); });
  api.runtime.onStartup.addListener(() => { schedule().then(() => PC.inbox.poll({ force: true })).catch(() => {}); });
  api.runtime.onInstalled.addListener(({ reason }) => {
    schedule().catch(() => {});
    migrate().catch(() => {});
    dropOldScript().catch(() => {});
    if (reason === "install") api.tabs.create({ url: api.runtime.getURL("src/pages/options.html#welcome") });
  });
  api.notifications.onClicked.addListener((id) => api.notifications.clear(id));

  // A background that wakes for any reason (a message, the alarm) makes sure the alarm and badge are right.
  schedule().then(() => PC.inbox.badge()).catch(() => {});
})(globalThis);
