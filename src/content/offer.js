/* AuthSkip: the offer on sign-in pages, for people who turned on "Offer codes on sign-in pages" (which asks for the
   all-sites permission and registers util.js, themes.js, fill.js and offer.js on every page). It does three things and
   keeps nothing: it looks for code boxes (fill.js), it reads the codes the background script found out of storage,
   and when a fresh one exists it draws a small card by the box: the code, where it came from, and a Fill key (or, in
   "fill it for me" mode, it fills as soon as the code arrives). The card wears the theme the popup does. While a code
   box is on screen it also asks the background to check the inboxes every five seconds for up to three minutes, so
   the code shows up as soon as the email does. Nothing on the page is read except the boxes' own attributes, and
   nothing from the page is sent anywhere. */
(function (g) {
  const AS = g.AS;
  const api = AS.api;
  if (!AS.fill || !AS.themes || AS.offerOn || g.top !== g.self && g.innerWidth < 120) return;
  AS.offerOn = true;

  const doc = g.document;
  let host = null, shadow = null, chip = null, label = null, sub = null;
  let targets = [], target = null, offer = null, settings = AS.DEFAULTS;
  const dismissed = new Set();
  const filledAuto = new Set();
  let armedAt = 0, ticks = 0, timer = 0, scanTimer = 0, raf = 0;

  // Colours are the theme's tokens (themes.pick, the same theme the popup shows), set on .chip as --<token>
  const TOKENS = ["surface", "surface2", "line", "text", "text3", "accent", "on-accent", "chrome-bg", "disp-bg", "disp-fg"];
  const CSS = `
    :host { all: initial; }
    .chip { position: fixed; display: flex; align-items: center; gap: 4px; padding: 6px 4px 6px 12px; max-width: min(380px, 94vw); box-sizing: border-box;
      font: 13px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--text); background: var(--surface);
      border-radius: 8px; box-shadow: 0 0 0 1px var(--line), 0 8px 24px rgba(0, 0, 0, .18); }
    button { all: unset; cursor: pointer; box-sizing: border-box; }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .info { display: grid; gap: 1px; min-width: 0; flex: 1; margin-right: 8px; }
    .code { font: 700 18px/1.2 ui-monospace, "Cascadia Mono", "SF Mono", Menlo, Consolas, monospace; letter-spacing: .06em; color: var(--text); white-space: nowrap; }
    .sub { font-size: 12px; color: var(--text3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .go { font-weight: 600; background: var(--accent); color: var(--on-accent); border-radius: 6px; padding: 7px 14px; }
    .go:hover { filter: brightness(.94); }
    .x { width: 30px; height: 30px; border-radius: 6px; display: grid; place-items: center; font-size: 18px; color: var(--text3); }
    .x:hover { background: var(--surface2); color: var(--text); }
    .chip[data-look="pocket"] { border-radius: 14px; box-shadow: 0 0 0 1px var(--line), 0 3px 0 var(--line), 0 10px 24px rgba(0, 0, 0, .22); }
    .chip[data-look="pocket"] .code { justify-self: start; background: var(--disp-bg); color: var(--disp-fg); border-radius: 4px; padding: 2px 7px; margin: 2px 2px 3px;
      box-shadow: inset 0 0 0 1px rgba(0, 0, 0, .25), 0 0 0 2px var(--chrome-bg); }
    .chip[data-look="pocket"] .go { border-radius: 10px; box-shadow: inset 0 1px 0 rgba(255, 255, 255, .3), 0 3px 0 color-mix(in srgb, var(--accent) 55%, #000); margin-bottom: 3px; }
    .chip[data-look="pocket"] .go:active { transform: translateY(3px); box-shadow: none; }
    @media (prefers-reduced-motion: reduce) { .chip[data-look="pocket"] .go:active { transform: none; } }`;

  function build() {
    host = doc.createElement("authskip-chip");
    host.style.cssText = "all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;";
    shadow = host.attachShadow({ mode: "closed" });
    const style = doc.createElement("style");
    style.textContent = CSS;
    chip = doc.createElement("div");
    chip.className = "chip";
    chip.setAttribute("role", "group");
    chip.setAttribute("aria-label", "AuthSkip");
    const info = doc.createElement("span");
    info.className = "info";
    label = doc.createElement("span");
    label.className = "code";
    sub = doc.createElement("span");
    sub.className = "sub";
    info.append(label, sub);
    const fillKey = doc.createElement("button");
    fillKey.className = "go";
    fillKey.type = "button";
    fillKey.textContent = "Fill";
    const x = doc.createElement("button");
    x.className = "x";
    x.type = "button";
    x.setAttribute("aria-label", "Dismiss");
    x.title = "Dismiss";
    x.textContent = "×";
    chip.append(info, fillKey, x);
    shadow.append(style, chip);
    fillKey.addEventListener("click", () => use());
    x.addEventListener("click", () => dismiss());
    (doc.body || doc.documentElement).appendChild(host);
  }

  function theme(themes) {
    const t = AS.themes.pick(settings, AS.themes.BUILTIN.concat(themes || []));
    for (const k of TOKENS) chip.style.setProperty("--" + k, t.tokens[k]);
    chip.dataset.look = t.look;
  }

  const group = (code) => (/^\d{6}$/.test(code) ? code.slice(0, 3) + " " + code.slice(3) : /^\d{8}$/.test(code) ? code.slice(0, 4) + " " + code.slice(4) : code);

  function place() {
    raf = 0;
    if (!chip || !offer || !target) return;
    const el = target.el || target.els[0];
    if (!AS.fill.visible(el)) { chip.style.display = "none"; return; }
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
    if (AS.fill.fill(offer.code, [target])) {
      api.runtime.sendMessage({ type: "used", id: offer.id }).catch(() => {});
      dismissed.add(offer.id);
      offer = null;
      hide();
    }
  }
  function dismiss() { if (offer) dismissed.add(offer.id); offer = null; hide(); }

  async function refresh() {
    settings = await AS.store.settings();
    if (!targets.length) { offer = null; hide(); return; }
    const codes = await AS.store.get("codes", []);
    const now = Date.now();
    offer = codes.find((c) => !c.used && !dismissed.has(c.id) && now - c.at < settings.fresh * AS.MIN) || null;
    if (!offer) { hide(); return; }
    if (settings.fill === "auto" && !filledAuto.has(offer.id)) {
      filledAuto.add(offer.id);
      use();
      return;
    }
    if (!chip) build();
    theme(await AS.store.get("themes", []));
    label.textContent = group(offer.code);
    sub.textContent = `${offer.from} · ${offer.email} · ${AS.ago(offer.at)}`;
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
    targets = AS.fill.find();
    const active = doc.activeElement;
    target = targets.find((t) => (t.el || null) === active || (t.els && t.els.includes(active))) || targets[0] || null;
    if (targets.length) arm();
    refresh().catch(() => {});
  }
  const later = () => { if (!scanTimer) scanTimer = setTimeout(scan, 300); };

  new MutationObserver(later).observe(doc.documentElement, { childList: true, subtree: true });
  doc.addEventListener("focusin", later, true);
  doc.addEventListener("keydown", (e) => { if (e.key === "Escape" && offer) dismiss(); }, true);
  g.addEventListener("scroll", schedulePlace, true);
  g.addEventListener("resize", schedulePlace);
  api.storage.onChanged.addListener((ch, area) => { if (area === "local" && (ch.codes || ch.settings || ch.themes)) refresh().catch(() => {}); });
  scan();
})(globalThis);
