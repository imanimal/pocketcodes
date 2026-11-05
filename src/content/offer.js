/* PocketCodes: the offer on sign-in pages, for people who turned on "Offer codes on sign-in pages" (which asks for the
   all-sites permission and registers fill.js and offer.js on every page). It does three things and keeps nothing:
   it looks for code boxes (fill.js), it reads the codes the background script found out of storage, and when a fresh
   one exists it draws a small chip by the box: the code, where it came from, and a Fill key (or, in "fill it for me"
   mode, it fills as soon as the code arrives). While a code box is on screen it also asks the background to check
   the inboxes every five seconds for up to three minutes, so the code shows up as soon as the email does. Only a
   tab you're looking at shows or fills a code, so a box left open in the background never uses one up.
   Nothing on the page is read except the boxes and the text of the form around them (fill.js), and nothing from
   the page is sent anywhere. */
(function (g) {
  const PC = g.PC;
  const api = PC.api;
  if (!PC.fill || PC.offerOn || g.top !== g.self && g.innerWidth < 120) return;
  PC.offerOn = true;

  const doc = g.document;
  let host = null, shadow = null, chip = null, label = null, sub = null;
  let targets = [], target = null, offer = null, settings = PC.DEFAULTS;
  const dismissed = new Set();
  const filledAuto = new Set();
  let armedAt = 0, ticks = 0, timer = 0, scanTimer = 0, raf = 0;

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
    .code { font: 800 19px/1.15 ui-monospace, "Cascadia Mono", Consolas, Menlo, monospace; letter-spacing: .08em; }
    .sub { font-size: 11px; opacity: .75; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .go { padding: 7px 12px; border-radius: 9px; font-weight: 700; font-size: 13px; color: #1b1915; background: #ff5b1f;
      box-shadow: inset 0 1px 0 rgba(255,255,255,.3), 0 0 0 1px #8a2f0d, 0 3px 0 #8a2f0d; }
    .go:active { transform: translateY(3px); box-shadow: inset 0 1px 0 rgba(255,255,255,.3), 0 0 0 1px #8a2f0d; }
    .x { width: 24px; height: 24px; font-size: 16px; color: #a39c8d; display: grid; place-items: center; border-radius: 6px; }
    .x:hover, .x:focus-visible { background: #3a3631; color: #ece6da; }
    :focus-visible { outline: 2px solid #ff5b1f; outline-offset: 2px; }
    @media (prefers-color-scheme: dark) {
      .chip { background: #0f0e0d; box-shadow: 0 0 0 1px #3f3c36, 0 3px 0 #000, 0 10px 24px rgba(0,0,0,.5); }
      .lcd { background-color: #45b3a1; color: #04211c; background-image: radial-gradient(rgba(4,33,28,.1) 1px, transparent 1.3px); }
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
    // the LCD and the orange key both fill, so the whole chip is one easy target
    const lcd = doc.createElement("button");
    lcd.className = "lcd";
    lcd.type = "button";
    label = doc.createElement("span");
    label.className = "code";
    sub = doc.createElement("span");
    sub.className = "sub";
    lcd.append(label, sub);
    const fillKey = doc.createElement("button");
    fillKey.className = "go";
    fillKey.type = "button";
    fillKey.textContent = "Fill";
    const x = doc.createElement("button");
    x.className = "x";
    x.type = "button";
    x.setAttribute("aria-label", "Dismiss");
    x.textContent = "×";
    chip.append(lcd, fillKey, x);
    shadow.append(style, chip);
    lcd.addEventListener("click", () => use());
    fillKey.addEventListener("click", () => use());
    x.addEventListener("click", () => dismiss());
    (doc.body || doc.documentElement).appendChild(host);
  }

  const group = (code) => (/^\d{6}$/.test(code) ? code.slice(0, 3) + " " + code.slice(3) : /^\d{8}$/.test(code) ? code.slice(0, 4) + " " + code.slice(4) : code);

  function place() {
    raf = 0;
    if (!chip || !offer || !target) return;
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

  function hide() { if (chip) chip.style.display = "none"; }

  function use() {
    if (!offer || !target) return;
    if (PC.fill.fill(offer.code, [target])) {
      api.runtime.sendMessage({ type: "used", id: offer.id }).catch(() => {});
      dismissed.add(offer.id);
      offer = null;
      hide();
    }
  }
  function dismiss() { if (offer) dismissed.add(offer.id); offer = null; hide(); }

  async function refresh() {
    settings = await PC.store.settings();
    if (!targets.length) { offer = null; hide(); return; }
    const codes = await PC.store.get("codes", []);
    const now = Date.now();
    offer = codes.find((c) => !c.used && !dismissed.has(c.id) && now - c.at < settings.fresh * PC.MIN) || null;
    if (!offer) { hide(); return; }
    // only the tab you're looking at takes a code: a box left open in a background tab mustn't use it up
    if (doc.visibilityState !== "visible") { hide(); return; }
    if (settings.fill === "auto" && !filledAuto.has(offer.id)) {
      filledAuto.add(offer.id);
      use();
      return;
    }
    if (!chip) build();
    label.textContent = group(offer.code);
    sub.textContent = `${offer.from} · ${offer.email} · ${PC.ago(offer.at)}`;
    place();
  }

  function arm() {
    const now = Date.now();
    if (now - armedAt < 60e3) return;
    armedAt = now;
    ticks = 0;
    clearInterval(timer);
    const tick = () => {
      if (!targets.length || ticks >= 36) { clearInterval(timer); return; }
      if (doc.visibilityState !== "visible") return;
      ticks++;
      api.runtime.sendMessage({ type: "poll", fast: true }).catch(() => {});
    };
    timer = setInterval(tick, 5000);
    tick();
  }

  function scan() {
    scanTimer = 0;
    targets = PC.fill.find();
    const active = doc.activeElement;
    target = targets.find((t) => (t.el || null) === active || (t.els && t.els.includes(active))) || targets[0] || null;
    if (targets.length) arm();
    refresh().catch(() => {});
  }
  const later = () => { if (!scanTimer) scanTimer = setTimeout(scan, 300); };

  new MutationObserver(later).observe(doc.documentElement, { childList: true, subtree: true });
  doc.addEventListener("focusin", later, true);
  doc.addEventListener("visibilitychange", () => refresh().catch(() => {}));
  doc.addEventListener("keydown", (e) => { if (e.key === "Escape" && offer) dismiss(); }, true);
  g.addEventListener("scroll", schedulePlace, true);
  g.addEventListener("resize", schedulePlace);
  api.storage.onChanged.addListener((ch, area) => { if (area === "local" && (ch.codes || ch.settings)) refresh().catch(() => {}); });
  scan();
})(globalThis);
