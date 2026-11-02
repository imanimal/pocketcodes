/* AuthSkip: the background script. Firefox runs it as an event page after the manifest's script list, Chrome as the
   service worker, which has to load the same libraries itself (importScripts, which Firefox's page doesn't have).
   It owns every write to the accounts, tokens, codes and statuses; the popup, the options page and the sign-in
   pages' script only read storage and send it messages (below). A check runs on the alarm (settings.every minutes),
   at startup, on "Check now", and every few seconds while a popup is open or a page is waiting for a code. */
if (typeof importScripts === "function") {
  importScripts("lib/util.js", "lib/codes.js", "lib/google.js", "lib/microsoft.js", "lib/imap.js", "lib/inbox.js");
}
(function (g) {
  const AS = g.AS;
  const api = AS.api;
  const ALARM = "authskip-poll";
  const PAGE_SCRIPT = "authskip-offer";

  async function schedule() {
    const s = await AS.store.settings();
    const every = Math.max(1, Number(s.every) || 1);
    const cur = await api.alarms.get(ALARM);
    if (!cur || cur.periodInMinutes !== every) await api.alarms.create(ALARM, { delayInMinutes: 0.2, periodInMinutes: every });
  }

  /** Puts the offer script on every page (or takes it off). Needs the all-sites permission, asked on the options page. */
  async function registerPage(on) {
    const has = (await api.scripting.getRegisteredContentScripts({ ids: [PAGE_SCRIPT] })).length > 0;
    // always registered afresh, so an update that changes the file list takes effect
    if (has) await api.scripting.unregisterContentScripts({ ids: [PAGE_SCRIPT] });
    if (!on) return { ok: true };
    if (!(await api.permissions.contains({ origins: ["<all_urls>"] }))) return { error: "AuthSkip doesn't have permission to run on all sites." };
    await api.scripting.registerContentScripts([{
      id: PAGE_SCRIPT, matches: ["<all_urls>"], js: ["src/lib/util.js", "src/lib/themes.js", "src/content/fill.js", "src/content/offer.js"],
      runAt: "document_idle", allFrames: true, persistAcrossSessions: true,
    }]);
    return { ok: true };
  }

  /** Fills a code (default: the newest fresh one) into the active tab's code boxes. */
  async function fillTab(tabId, id) {
    const codes = await AS.store.get("codes", []);
    const c = id ? codes.find((x) => x.id === id) : await AS.inbox.newest(codes);
    if (!c) return { ok: false, reason: "No fresh code to fill." };
    if (tabId == null) {
      const [tab] = await api.tabs.query({ active: true, currentWindow: true });
      tabId = tab && tab.id;
    }
    if (tabId == null) return { ok: false, reason: "No page to fill." };
    let results;
    try {
      await api.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["src/lib/util.js", "src/content/fill.js"] });
      results = await api.scripting.executeScript({ target: { tabId, allFrames: true }, func: (code) => !!(globalThis.AS && globalThis.AS.fill && globalThis.AS.fill.fill(code)), args: [c.code] });
    } catch (e) {
      return { ok: false, reason: "This page doesn't let extensions in." };
    }
    if (!results.some((r) => r && r.result)) return { ok: false, reason: "No code box on this page.", code: c.code };
    await AS.inbox.mark("used", [c.id]);
    return { ok: true, code: c.code };
  }

  const handlers = {
    poll: (m) => AS.inbox.poll({ fast: !!m.fast, force: !!m.force, only: m.only }).then(() => ({ ok: true })),
    addOAuth: (m) => AS.inbox.addOAuth(m.kind, m.hint).then((a) => ({ ok: true, account: a })),
    addImap: (m) => AS.inbox.addImap(m).then((a) => ({ ok: true, account: a })),
    remove: (m) => AS.inbox.removeAccount(m.id).then(() => ({ ok: true })),
    seen: () => AS.inbox.mark("seen", "all").then(() => ({ ok: true })),
    used: (m) => AS.inbox.mark("used", [m.id]).then(() => ({ ok: true })),
    fill: (m) => fillTab(m.tabId, m.id),
    page: (m) => registerPage(!!m.on),
    helper: () => AS.imap.status().then((r) => ({ ok: true, helper: r })),
    clear: () => AS.mutex("codes", () => AS.store.set("codes", [])).then(() => AS.inbox.badge()).then(() => ({ ok: true })),
    settings: () => schedule().then(() => AS.inbox.badge()).then(() => ({ ok: true })),
  };

  // Chrome ignores a returned Promise, so answer with sendResponse and say so with `return true`.
  api.runtime.onMessage.addListener((m, sender, sendResponse) => {
    const h = m && handlers[m.type];
    if (!h) return false;
    h(m).then(sendResponse, (e) => sendResponse({ error: String((e && e.message) || e), auth: !!(e && e.auth), code: e && e.code }));
    return true;
  });

  api.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) AS.inbox.poll({}).catch(() => {}); });
  api.commands.onCommand.addListener((cmd) => { if (cmd === "fill-code") fillTab(null).catch(() => {}); });
  api.runtime.onStartup.addListener(() => { schedule().then(() => AS.inbox.poll({ force: true })).catch(() => {}); });
  api.runtime.onInstalled.addListener(({ reason }) => {
    schedule().catch(() => {});
    if (reason === "install") api.tabs.create({ url: api.runtime.getURL("src/pages/options.html#welcome") });
    if (reason === "update") AS.store.settings().then((s) => s.page && registerPage(true)).catch(() => {});
  });
  if (api.permissions && api.permissions.onRemoved) {
    api.permissions.onRemoved.addListener((p) => {
      if ((p.origins || []).includes("<all_urls>")) AS.store.setSettings({ page: false }).then(() => registerPage(false)).catch(() => {});
    });
  }
  api.notifications.onClicked.addListener((id) => api.notifications.clear(id));

  // A background that wakes for any reason (a message, the alarm) makes sure the alarm and badge are right.
  schedule().then(() => AS.inbox.badge()).catch(() => {});
})(globalThis);
