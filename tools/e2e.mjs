// PocketCodes end to end in a real Firefox (Node 22+, no packages). It starts a headless Firefox with a throwaway
// profile, installs this folder as a temporary add-on over WebDriver BiDi, turns on "Offer codes on sign-in pages"
// the way the settings page does (permission request, then the background's "page" message), puts a fresh code in
// storage, and checks that real pages get it:
//   - tests/fixtures/run.html passes in Gecko (the detection and chip cases)
//   - the registered content script auto-fills a code box, and fills one that appears later
//   - in "ask" mode the chip appears and the box stays empty
//   - a sign-in page without a code box is left alone
//   - the Fill command path (background fillTab through scripting.executeScript) fills the active tab
//   - the IMAP helper answers, if it's installed
// Run from the repo root:  node tools/e2e.mjs   (FIREFOX=path/to/firefox to pick a build)
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ID = "codes@imanimal.github.io";
const UUID = "5e2a1b0c-0d0e-4f00-8000-00000000c0de";
const BASE = `moz-extension://${UUID}`;
const FIREFOX = process.env.FIREFOX || ["C:/Program Files/Mozilla Firefox/firefox.exe", "/Applications/Firefox.app/Contents/MacOS/firefox", "/usr/bin/firefox"].find(existsSync);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── a static server for the fixtures ──
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json" };
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  try { const body = await readFile(join(ROOT, path)); res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream", "cache-control": "no-store" }); res.end(body); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const SITE = `http://127.0.0.1:${server.address().port}`;

// ── Firefox ──
const profile = mkdtempSync(join(tmpdir(), "pocketcodes-e2e-"));
writeFileSync(join(profile, "user.js"), [
  `user_pref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify({ [ID]: UUID }))});`,
  `user_pref("extensions.webextOptionalPermissionPrompts", false);`,
  `user_pref("browser.shell.checkDefaultBrowser", false);`,
  `user_pref("datareporting.policy.dataSubmissionEnabled", false);`,
  `user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);`,
  `user_pref("browser.aboutwelcome.enabled", false);`,
  // SCHEME=dark or light shows pages that way whatever the system uses (for screenshots)
  ...(process.env.SCHEME === "dark" ? [`user_pref("layout.css.prefers-color-scheme.content-override", 0);`, `user_pref("ui.systemUsesDarkTheme", 1);`] : []),
  ...(process.env.SCHEME === "light" ? [`user_pref("layout.css.prefers-color-scheme.content-override", 1);`, `user_pref("ui.systemUsesDarkTheme", 0);`] : []),
].join("\n"));
const port = 9300 + Math.floor(Math.random() * 400);
const ff = spawn(FIREFOX, ["-headless", "-no-remote", "-profile", profile, "--remote-debugging-port", String(port)], {
  stdio: "ignore", env: Object.assign({}, process.env, { MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1" }), // to script the extension's own pages
});

let ws, seq = 0;
const pending = new Map();
async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}/session`);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
      ws.onmessage = (e) => { const m = JSON.parse(e.data); const p = m.id && pending.get(m.id); if (p) { pending.delete(m.id); m.type === "error" ? p.rej(new Error(m.error + ": " + m.message)) : p.res(m.result); } };
      return;
    } catch { await wait(500); }
  }
  throw new Error("Firefox's remote agent didn't start");
}
const bidi = (method, params) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });

async function tab(url, background) {
  const { context } = await bidi("browsingContext.create", { type: "tab", background: !!background });
  await bidi("browsingContext.navigate", { context, url, wait: "complete" });
  return context;
}
/** Runs `fn` (a function's source) in the page, awaiting a promise, with a user gesture, and returns its JSON. */
async function run(context, fn, ...args) {
  const r = await bidi("script.callFunction", { functionDeclaration: fn.toString(), target: { context }, awaitPromise: true, userActivation: true,
    arguments: args.map((a) => ({ type: "string", value: JSON.stringify(a) })), resultOwnership: "none" });
  if (r.type === "exception") throw new Error(r.exceptionDetails.text);
  return r.result.type === "string" ? JSON.parse(r.result.value) : r.result.value;
}
async function until(context, fn, ms = 8000) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await run(context, fn).catch(() => false)) return true; await wait(250); }
  return false;
}

/** Puts a fresh code at the top of the list (as the background would on finding one) and merges `settings`. */
const give = (context, code, settings) => run(context, async (args) => {
  const { code, settings } = JSON.parse(args);
  const api = globalThis.browser;
  const cur = await api.storage.local.get(["codes", "settings"]);
  const c = { id: "g:e2e-" + code, acct: "google:you@example.com", email: "you@example.com", kind: "google", code, from: "Example", subject: "Your code", at: Date.now(), found: Date.now(), seen: false, used: false };
  await api.storage.local.set({ codes: [c].concat(cur.codes || []), settings: Object.assign(cur.settings || {}, settings || {}) });
  return "1";
}, { code, settings });

const state = (context) => run(context, async () => {
  const r = await globalThis.browser.storage.local.get(["codes", "settings"]);
  return JSON.stringify({ codes: (r.codes || []).map((c) => c.code + (c.used ? "u" : "")), fill: (r.settings || {}).fill, page: (r.settings || {}).page });
});

const results = [];
const check = (ok, name, detail) => { results.push({ ok, name }); console.log(`${ok ? "pass" : "FAIL"}  ${name}${!ok && detail ? "  (" + detail + ")" : ""}`); };

try {
  await connect();
  await bidi("session.new", { capabilities: {} });
  await bidi("webExtension.install", { extensionData: { type: "path", path: ROOT } });
  await wait(1500);

  // the settings page, as the person would use it: the add-on opens it on install (BiDi can't navigate to it)
  let opts = null;
  for (let i = 0; i < 40 && !opts; i++) {
    const { contexts } = await bidi("browsingContext.getTree", {});
    const c = contexts.find((x) => x.url.startsWith(`${BASE}/src/pages/options.html`));
    if (c) opts = c.context; else await wait(250);
  }
  if (!opts) throw new Error("the settings page didn't open on install");
  // a real click on step 2's "Turn on" (Firefox grants permissions only from user input)
  await run(opts, () => { document.querySelector("button[data-act=pageOn]").scrollIntoView({ block: "center" }); return "1"; });
  const { nodes } = await bidi("browsingContext.locateNodes", { context: opts, locator: { type: "css", value: "button[data-act=pageOn]" } });
  await bidi("input.performActions", { context: opts, actions: [{ type: "pointer", id: "mouse", actions: [
    { type: "pointerMove", x: 0, y: 0, origin: { type: "element", element: { sharedId: nodes[0].sharedId } } },
    { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }] }] });
  await until(opts, async () => ((await globalThis.browser.storage.local.get("settings")).settings || {}).page === true);
  const setup = await run(opts, async (code) => {
    const api = globalThis.browser;
    const ok = await api.permissions.contains({ origins: ["<all_urls>"] });
    const r = { ok: (await api.scripting.getRegisteredContentScripts()).some((s) => s.id === "pocketcodes-offer") };
    await api.storage.local.set({ settings: Object.assign({}, globalThis.PC.DEFAULTS, { page: true, fill: "auto", notify: false }), codes: [] });
    return JSON.stringify({ ok, r });
  });
  check(setup.ok && setup.r && setup.r.ok, "settings page turns on sign-in page offers", JSON.stringify(setup));

  // the fixtures in Gecko
  const fx = await tab(`${SITE}/tests/fixtures/run.html`);
  await until(fx, () => !!window.RESULT, 30000);
  const fr = await run(fx, () => JSON.stringify(window.RESULT || { fail: -1, rows: [] }));
  check(fr.fail === 0, `fixture page in Firefox: ${fr.pass} passed`, fr.rows.filter((r) => !r.ok).map((r) => r.name + ": " + r.detail).join("; "));
  await bidi("browsingContext.close", { context: fx }); // its frames have code boxes of their own

  // the real registered content script. A code box in a background tab must leave the code alone...
  const bg = await tab(`${SITE}/tests/fixtures/page-otp.html?bg`, true);
  await wait(800);
  await give(opts, "482913");
  await wait(1500);
  const bgValue = await run(bg, () => JSON.stringify(document.getElementById("otp").value));
  const unused = await run(opts, async () => JSON.stringify(!(await globalThis.browser.storage.local.get("codes")).codes[0].used));
  check(bgValue === "" && unused, "a code box in a background tab doesn't take the code", `value=${bgValue} unused=${unused}`);
  // ...and the tab you're looking at takes it
  const p1 = await tab(`${SITE}/tests/fixtures/page-otp.html`);
  check(await until(p1, () => document.getElementById("otp").value === "482913"), "auto mode fills a code box on a real page",
    JSON.stringify(await state(opts)) + " p1=" + (await run(p1, () => JSON.stringify(document.getElementById("otp").value + "|" + document.visibilityState + "|" + !!document.querySelector("pocketcodes-chip")))));
  const used = await run(opts, async () => JSON.stringify((await globalThis.browser.storage.local.get("codes")).codes[0].used));
  check(used === true, "the filled code is marked used");

  const p2 = await tab(`${SITE}/tests/fixtures/page-late.html`);
  await give(opts, "735201");
  check(await until(p2, () => { const i = document.getElementById("late"); return !!i && i.value === "735201"; }), "a code box that appears later gets filled");

  await give(opts, "246810", { fill: "ask" });
  const p3 = await tab(`${SITE}/tests/fixtures/page-otp.html`);
  const chip = await until(p3, () => !!document.querySelector("pocketcodes-chip"));
  const empty = await run(p3, () => JSON.stringify(document.getElementById("otp").value === ""));
  check(chip && empty, "ask mode shows the chip and leaves the box alone");

  const p4 = await tab(`${SITE}/tests/fixtures/page-login.html`);
  await wait(2000);
  check(!(await run(p4, () => JSON.stringify(!!document.querySelector("pocketcodes-chip")))), "no chip on a sign-in page without a code box");

  // the popup's Fill / Alt+Shift+F path: the background injects fill.js into a tab and fills it
  const p5 = await tab(`${SITE}/tests/fixtures/page-otp.html?fill`);
  const filled = await run(opts, async () => {
    const api = globalThis.browser;
    const [t] = await api.tabs.query({ url: "*://127.0.0.1/*fill*" });
    return JSON.stringify(await api.runtime.sendMessage({ type: "fill", tabId: t.id, id: "g:e2e-246810" }));
  });
  const value = await run(p5, () => JSON.stringify(document.getElementById("otp").value));
  check(filled.ok && value === "246810", "Fill puts the code into the tab", JSON.stringify(filled) + " value=" + value);

  const helper = await run(opts, async () => JSON.stringify(await globalThis.browser.runtime.sendMessage({ type: "helper" })));
  if (!helper.ok && helper.code === "no-host") console.log("skip  IMAP helper (not installed here)");
  else check(helper.ok, helper.ok ? `IMAP helper answers (version ${helper.helper.version})` : "IMAP helper answers", helper.error);

  // SHOTS=<folder>: a screenshot of the chip on a sign-in page
  if (process.env.SHOTS) {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(process.env.SHOTS, { recursive: true });
    const tag = process.env.SCHEME === "dark" ? "night" : "cream";
    // (extension pages can't be captured over BiDi; tests/fixtures/preview.html shows the popup and settings)
    const shot = async (context, name, w, h) => {
      await bidi("browsingContext.setViewport", { context, viewport: { width: w, height: h } });
      await wait(700);
      const { data } = await bidi("browsingContext.captureScreenshot", { context, origin: "document" });
      writeFileSync(join(process.env.SHOTS, `${name}-${tag}.png`), Buffer.from(data, "base64"));
    };
    await give(opts, "482913", { fill: "ask" });
    const ch = await tab(`${SITE}/tests/fixtures/page-otp.html?shot`);
    await until(ch, () => !!document.querySelector("pocketcodes-chip"));
    await shot(ch, "chip", 520, 220);
    console.log(`screenshots in ${process.env.SHOTS}`);
  }
} catch (e) {
  check(false, "runner", e.stack || String(e));
} finally {
  try { await bidi("session.end", {}); } catch {}
  ff.kill();
  server.close();
  await wait(1000);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
const fail = results.filter((r) => !r.ok).length;
console.log(fail ? `\n${fail} failed of ${results.length}` : `\nAll ${results.length} passed`);
process.exit(fail ? 1 : 0);
