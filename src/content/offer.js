/* AuthSkip: the offer on sign-in pages, for people who turned on "Offer codes on sign-in pages" (which asks for the
   all-sites permission and registers fill.js and offer.js on every page). It does three things and keeps nothing:
   it looks for code boxes (fill.js), it reads the codes the background script found out of storage, and when a fresh
   one exists it draws a small chip by the box: the code, where it came from, and a Fill key (or, in "fill it for me"
   mode, it fills as soon as the code arrives). While a code box is on screen it also asks the background to check
   the inboxes every five seconds for up to three minutes, so the code shows up as soon as the email does.
   Nothing on the page is read except the boxes' own attributes, and nothing from the page is sent anywhere. */
(function (g) {
  const AS = g.AS;
  const api = AS.api;
  if (!AS.fill || AS.offerOn || g.top !== g.self && g.innerWidth < 120) return;
  AS.offerOn = true;

  const doc = g.document;
  let host = null, shadow = null, chip = null, label = null, sub = null;
  let targets = [], target = null, offer = null, settings = AS.DEFAULTS;
  const dismissed = new Set();
  const filledAuto = new Set();
  let armedAt = 0, ticks = 0, timer = 0, scanTimer = 0, raf = 0;

  const CSS = `
    :host { all: initial; }
    .chip { position: fixed; display: flex; align-items: stretch; font: 13px/1.3 system-ui, sans-serif; color: #24221e; background: #fff;
      border: 1px solid #c9c5ba; border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,.2); overflow: hidden; max-width: min(340px, 94vw); }
    button { all: unset; cursor: pointer; box-sizing: border-box; }
    .fill { display: grid; gap: 1px; padding: 7px 12px; text-align: left; min-width: 0; }
    .fill:hover, .fill:focus-visible { background: #eef2fb; }
    .code { font: 700 17px/1.2 ui-monospace, Consolas, Menlo, monospace; letter-spacing: .06em; color: #2a4fa8; }
    .sub { font-size: 12px; color: #6b665c; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .x { padding: 0 10px; font-size: 18px; color: #6b665c; border-left: 1px solid #e3dfd5; display: grid; place-items: center; }
    .x:hover, .x:focus-visible { background: #f4f1ea; color: #24221e; }
    @media (prefers-color-scheme: dark) {
      .chip { color: #ece9e1; background: #24221e; border-color: #4a463e; }
      .fill:hover, .fill:focus-visible { background: #2c3550; }
      .code { color: #9db5f2; } .sub, .x { color: #a8a396; } .x { border-color: #3a372f; } .x:hover, .x:focus-visible { background: #33302a; color: #ece9e1; }
    }`;

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
    const fillKey = doc.createElement("button");
    fillKey.className = "fill";
    fillKey.type = "button";
    label = doc.createElement("span");
    label.className = "code";
    sub = doc.createElement("span");
    sub.className = "sub";
    fillKey.append(label, sub);
    const x = doc.createElement("button");
    x.className = "x";
    x.type = "button";
    x.setAttribute("aria-label", "Dismiss");
    x.textContent = "×";
    chip.append(fillKey, x);
    shadow.append(style, chip);
    fillKey.addEventListener("click", () => use());
    x.addEventListener("click", () => dismiss());
    (doc.body || doc.documentElement).appendChild(host);
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
  api.storage.onChanged.addListener((ch, area) => { if (area === "local" && (ch.codes || ch.settings)) refresh().catch(() => {}); });
  scan();
})(globalThis);
