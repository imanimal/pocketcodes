/* PocketCodes: the chip on sign-in pages. It runs on every page (manifest.json's content_scripts, after util.js and
   fill.js) unless "Codes on sign-in pages" is off in Settings, and keeps nothing. When fill.js finds a code box and you
   have an inbox added, a small chip pops up by the box at once: "checking your inboxes…" while it asks the background
   to check every five seconds (for up to three minutes, then "no code yet" and a Check again key), and the code itself
   with a Fill key the moment the email lands. In "fill it for me" mode it fills the box instead. Only a tab you're
   looking at shows or fills a code, so a box left open in the background never uses one up. Escape or × puts the
   chip away: for that code, or while waiting, until a code arrives or a new box appears.
   Nothing on the page is read except the boxes and the text of the form around them (fill.js), and nothing from the
   page is sent anywhere. All a page can see is the host element and its data-state (waiting, idle or code). */
(function (g) {
  const PC = g.PC;
  const api = PC.api;
  if (!PC.fill || PC.offerOn || g.top !== g.self && g.innerWidth < 120) return;
  PC.offerOn = true;

  const doc = g.document;
  const WINDOW = 36; // fast checks per code box: every 5 s for 3 minutes
  let host = null, shadow = null, chip = null, lcd = null, label = null, sub = null, key = null;
  let targets = [], target = null, offer = null, state = "off", settings = PC.DEFAULTS;
  const dismissed = new Set();
  const filledAuto = new Set();
  let waitDismissed = false, checking = false, armedAt = 0, ticks = 0, timer = 0, scanTimer = 0, raf = 0;

  // a small Pocket device: graphite body, the code on an LCD, an orange Fill key (the page's fonts and colours can't
  // reach into the closed shadow root, and the extension's own fonts aren't exposed to pages, so system monospace)
  const CSS = `
    :host { all: initial; }
    .chip { position: fixed; display: flex; align-items: center; gap: 8px; padding: 6px 6px 6px 8px; box-sizing: border-box;
      font: 500 12px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif; color: #ece6da; background: #2a2722;
      border-radius: 12px; box-shadow: 0 0 0 1px #000, 0 3px 0 #000, 0 10px 24px rgba(0,0,0,.35); max-width: min(360px, 94vw); }
    button { all: unset; cursor: pointer; box-sizing: border-box; }
    .lcd { display: grid; gap: 1px; padding: 4px 10px 3px; border-radius: 6px; min-width: 0; text-align: left;
      background-color: #b1bd93; color: #1f2a17; background-image: radial-gradient(rgba(31,42,23,.09) 1px, transparent 1.3px); background-size: 3px 3px;
      box-shadow: inset 0 0 0 1px rgba(0,0,0,.28), inset 0 2px 4px rgba(0,0,0,.25); }
    .lcd.wait { cursor: default; }
    .lcd.wait .code { color: rgba(31,42,23,.45); letter-spacing: .14em; }
    .lcd.busy .code { animation: pc-blink 1.4s ease-in-out infinite; }
    @keyframes pc-blink { 50% { opacity: .35; } }
    @media (prefers-reduced-motion: reduce) { .lcd.busy .code { animation: none; } }
    .code { font: 800 19px/1.15 ui-monospace, "Cascadia Mono", Consolas, Menlo, monospace; letter-spacing: .08em; }
    .sub { font-size: 11px; opacity: .75; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .go { padding: 7px 12px; border-radius: 9px; font-weight: 700; font-size: 13px; color: #1b1915; background: #ff5b1f;
      white-space: nowrap; box-shadow: inset 0 1px 0 rgba(255,255,255,.3), 0 0 0 1px #8a2f0d, 0 3px 0 #8a2f0d; }
    .go:active { transform: translateY(3px); box-shadow: inset 0 1px 0 rgba(255,255,255,.3), 0 0 0 1px #8a2f0d; }
    .go[hidden] { display: none; }
    .x { width: 24px; height: 24px; font-size: 16px; color: #a39c8d; display: grid; place-items: center; border-radius: 6px; }
    .x:hover, .x:focus-visible { background: #3a3631; color: #ece6da; }
    :focus-visible { outline: 2px solid #ff5b1f; outline-offset: 2px; }
    @media (prefers-color-scheme: dark) {
      .chip { background: #0f0e0d; box-shadow: 0 0 0 1px #3f3c36, 0 3px 0 #000, 0 10px 24px rgba(0,0,0,.5); }
      .lcd { background-color: #45b3a1; color: #04211c; background-image: radial-gradient(rgba(4,33,28,.1) 1px, transparent 1.3px); }
      .lcd.wait .code { color: rgba(4,33,28,.45); }
      .go { background: #ff6a2b; }
    }`;

  function build() {
    host = doc.createElement("pocketcodes-chip");
    host.style.cssText = "all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;";
    shadow = host.attachShadow({ mode: "closed" });
    const style = doc.createElement("style");
    style.textContent = CSS;
    chip = doc.createElement("div");
    chip.className = "chip";
    chip.setAttribute("role", "group");
    chip.setAttribute("aria-label", "PocketCodes");
    chip.setAttribute("aria-live", "polite");
    // the LCD and the orange key both fill, so the whole chip is one easy target
    lcd = doc.createElement("button");
    lcd.className = "lcd";
    lcd.type = "button";
    label = doc.createElement("span");
    label.className = "code";
    sub = doc.createElement("span");
    sub.className = "sub";
    lcd.append(label, sub);
    key = doc.createElement("button");
    key.className = "go";
    key.type = "button";
    const x = doc.createElement("button");
    x.className = "x";
    x.type = "button";
    x.setAttribute("aria-label", "Dismiss");
    x.textContent = "×";
    chip.append(lcd, key, x);
    shadow.append(style, chip);
    lcd.addEventListener("click", () => { if (state === "code") use(); });
    key.addEventListener("click", () => {
      if (state === "code") use();
      else if (state === "idle") { armedAt = 0; arm(); }
    });
    x.addEventListener("click", () => dismiss());
    (doc.body || doc.documentElement).appendChild(host);
  }

  const group = (code) => (/^\d{6}$/.test(code) ? code.slice(0, 3) + " " + code.slice(3) : /^\d{8}$/.test(code) ? code.slice(0, 4) + " " + code.slice(4) : code);

  function place() {
    raf = 0;
    if (!chip || state === "off" || !target) return;
    const el = target.el || target.els[0];
    if (!PC.fill.visible(el)) { chip.style.display = "none"; return; }
    const r = el.getBoundingClientRect();
    chip.style.display = "flex";
    const h = chip.offsetHeight || 44, w = chip.offsetWidth || 220;
    let top = r.bottom + 6;
    if (top + h > g.innerHeight - 4) top = Math.max(4, r.top - h - 6);
    chip.style.top = Math.round(top) + "px";
    chip.style.left = Math.round(Math.min(Math.max(4, r.left), Math.max(4, g.innerWidth - w - 4))) + "px";
  }
  const schedulePlace = () => { if (!raf) raf = g.requestAnimationFrame(place); };

  /** Shows the chip as `next` (waiting, idle or code), or puts it away ("off"). */
  function show(next) {
    state = next;
    if (next === "off") {
      if (chip) chip.style.display = "none";
      if (host) delete host.dataset.state;
      return;
    }
    if (!chip) build();
    host.dataset.state = next;
    lcd.classList.toggle("wait", next !== "code");
    lcd.classList.toggle("busy", next === "waiting");
    if (next === "code") {
      label.textContent = group(offer.code);
      sub.textContent = `${offer.from} · ${offer.email} · ${PC.ago(offer.at)}`;
      key.textContent = "Fill";
      key.hidden = false;
    } else {
      label.textContent = "--- ---";
      sub.textContent = next === "waiting" ? "PocketCodes · checking your inboxes…" : "PocketCodes · no code yet";
      key.textContent = "Check again";
      key.hidden = next === "waiting";
    }
    place();
  }

  function stop() { clearInterval(timer); checking = false; }

  function use() {
    if (!offer || !target) return false;
    if (!PC.fill.fill(offer.code, [target])) return false;
    api.runtime.sendMessage({ type: "used", id: offer.id }).catch(() => {});
    dismissed.add(offer.id);
    offer = null;
    waitDismissed = true; // the box has its code: nothing more to wait for until a new box appears
    stop();
    show("off");
    return true;
  }
  function dismiss() {
    if (state === "code" && offer) dismissed.add(offer.id);
    else waitDismissed = true;
    offer = null;
    show("off");
  }

  async function refresh() {
    settings = await PC.store.settings();
    // only the tab you're looking at takes a code: a box left open in a background tab mustn't use it up
    if (!settings.page || !targets.length || doc.visibilityState !== "visible") { offer = null; show("off"); return; }
    const codes = await PC.store.get("codes", []);
    const now = Date.now();
    offer = codes.find((c) => !c.used && !dismissed.has(c.id) && now - c.at < settings.fresh * PC.MIN) || null;
    if (offer) {
      if (settings.fill === "auto" && !filledAuto.has(offer.id)) {
        filledAuto.add(offer.id);
        if (use()) return;
      }
      show("code");
      return;
    }
    const accounts = await PC.store.get("accounts", []);
    show(accounts.length && !waitDismissed ? (checking ? "waiting" : "idle") : "off");
  }

  /** Fast checks while a code box is on screen, so the code shows up as soon as the email does. */
  function arm() {
    const now = Date.now();
    if (now - armedAt < 60e3) return;
    armedAt = now;
    ticks = 0;
    checking = true;
    clearInterval(timer);
    const tick = () => {
      if (!targets.length || ticks >= WINDOW) { stop(); refresh().catch(() => {}); return; }
      if (doc.visibilityState !== "visible") return;
      ticks++;
      api.runtime.sendMessage({ type: "poll", fast: true }).catch(() => {});
    };
    timer = setInterval(tick, 5000);
    tick();
    refresh().catch(() => {});
  }

  async function scan() {
    scanTimer = 0;
    settings = await PC.store.settings();
    const before = targets;
    targets = settings.page ? PC.fill.find() : [];
    const active = doc.activeElement;
    target = targets.find((t) => (t.el || null) === active || (t.els && t.els.includes(active))) || targets[0] || null;
    // a box that wasn't there before (the next step of a sign-in) starts a fresh wait
    if (targets.length && !before.length) {
      waitDismissed = false;
      if ((await PC.store.get("accounts", [])).length) arm();
    }
    if (!targets.length) stop();
    await refresh();
  }
  const later = () => { if (!scanTimer) scanTimer = setTimeout(() => scan().catch(() => {}), 300); };

  new MutationObserver(later).observe(doc.documentElement, { childList: true, subtree: true });
  doc.addEventListener("focusin", later, true);
  doc.addEventListener("visibilitychange", () => refresh().catch(() => {}));
  doc.addEventListener("keydown", (e) => { if (e.key === "Escape" && state !== "off") dismiss(); }, true);
  g.addEventListener("scroll", schedulePlace, true);
  g.addEventListener("resize", schedulePlace);
  api.storage.onChanged.addListener((ch, area) => {
    if (area !== "local") return;
    if (ch.settings || ch.accounts) later();
    else if (ch.codes) refresh().catch(() => {});
  });
  scan().catch(() => {});
})(globalThis);
