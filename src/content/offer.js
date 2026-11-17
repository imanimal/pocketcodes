/* PocketCodes: the chip on sign-in pages. It runs on every page (manifest.json's content_scripts, after util.js and
   fill.js) unless "Codes on sign-in pages" is off in Settings, and keeps nothing. When fill.js finds a code box and you
   have an inbox added, it asks the background to check every five seconds (for up to three minutes) and shows the
   code by the box, with a Fill key, the moment the email lands. In "fill it for me" mode it fills the box instead.
   Only a tab you're looking at shows or fills a code, so a box left open in the background never uses one up.
   While it waits it is only a small, faint "Checking for a code" tag, since a box can look like a code box and not
   be one. The tag goes away by itself after twenty seconds (the checks carry on, and a code that lands still shows),
   and a click anywhere on it puts it away and keeps it away from that site (Settings brings it back). Escape or ×
   puts away whatever is showing, until a newer code arrives or a new box appears.
   It goes by how the page says it sent the code (fill.js's channel): an email (or a page that doesn't say) gets the
   inboxes' codes; a text gets only codes from texts, and no chip at all unless texts reach PocketCodes (a Mac's
   Messages, or forwarding to an inbox); an authenticator app gets this site's authenticator code, if one was added,
   and never a wait (a Duo passcode is one of these, on Duo's own page; filling it moves Duo's count on). The
   background answers that from the frame's own address, so a page only sees its own site's.
   A page with no code box that says it emailed a link to click (fill.js's prompt) gets that link instead, once the
   mail lands: where it goes, and an Open key that opens it in a new tab. Never by itself, never a waiting tag, and
   only a link that goes to this site or that this site's own mail sent.
   Nothing on the page is read except the boxes and the text of the form around them, or the short block that says
   a link was emailed (fill.js), and nothing from the page is sent anywhere. All a page can see is the host element
   and its data-state (waiting, code or link). */
(function (g) {
  const PC = g.PC;
  const api = PC.api;
  if (!PC.fill || PC.offerOn || g.top !== g.self && g.innerWidth < 120) return;
  PC.offerOn = true;

  const doc = g.document;
  const WINDOW = 36;      // fast checks per code box: every 5 s for 3 minutes
  const LINK_WINDOW = 24; // and per "we emailed you a link" page: 2 minutes
  const SHOW_WAIT = PC.SHOW_WAIT || 20e3; // how long the waiting tag stays up (the fixtures shorten it)
  const DUO_PAGE = /^api-[a-z0-9-]+\.duo(?:security|federal)\.com$/;
  const SITE = g.location.hostname.toLowerCase().replace(/^www\./, "");
  let host = null, shadow = null, chip = null, lcd = null, label = null, sub = null, key = null, x = null;
  let targets = [], target = null, via = "", offer = null, state = "off", settings = PC.DEFAULTS;
  const dismissed = new Set();
  const filledAuto = new Set();
  let waitDismissed = false, hushed = false, checking = false, armedAt = 0, ticks = 0, timer = 0, scanTimer = 0, waitTimer = 0, raf = 0, totpTimer = 0, totpUsed = false;
  let promptEl = null, promptAt = 0;

  // a small Pocket device: graphite body, the code on an LCD, an orange Fill key (the page's fonts and colours can't
  // reach into the closed shadow root, and the extension's own fonts aren't exposed to pages, so system monospace).
  // Waiting, it is only the tag: no LCD, no key, no lip.
  const CSS = `
    :host { all: initial; }
    .chip { position: fixed; display: flex; align-items: center; gap: 8px; padding: 6px 4px 6px 8px; box-sizing: border-box;
      font: 500 12px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif; color: #ece6da; background: #2a2722;
      border-radius: 12px; box-shadow: 0 0 0 1px #000, 0 2px 0 #000, 0 6px 16px rgba(0,0,0,.25); max-width: min(360px, 94vw); }
    button { all: unset; cursor: pointer; box-sizing: border-box; }
    .lcd { display: grid; gap: 1px; padding: 4px 10px 3px; border-radius: 6px; min-width: 0; text-align: left;
      background-color: #b1bd93; color: #1f2a17; background-image: radial-gradient(rgba(31,42,23,.09) 1px, transparent 1.3px); background-size: 3px 3px;
      box-shadow: inset 0 0 0 1px rgba(0,0,0,.28), inset 0 2px 4px rgba(0,0,0,.25); }
    .code { font: 800 19px/1.15 ui-monospace, "Cascadia Mono", Consolas, Menlo, monospace; letter-spacing: .08em; }
    .lcd.link .code { font-size: 13px; line-height: 1.4; letter-spacing: 0; }
    .code, .sub { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sub { font-size: 11px; opacity: .75; }
    .go { padding: 7px 12px; border-radius: 9px; font-weight: 700; font-size: 13px; color: #1b1915; background: #ff5b1f;
      white-space: nowrap; box-shadow: inset 0 1px 0 rgba(255,255,255,.3), 0 0 0 1px #8a2f0d, 0 3px 0 #8a2f0d; }
    .go:active { transform: translateY(3px); box-shadow: inset 0 1px 0 rgba(255,255,255,.3), 0 0 0 1px #8a2f0d; }
    .x { flex: none; width: 30px; height: 30px; font-size: 17px; color: #a39c8d; display: grid; place-items: center; border-radius: 8px; }
    .x:hover, .x:focus-visible { background: #3a3631; color: #ece6da; }
    .note { display: none; align-items: center; gap: 6px; white-space: nowrap; }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: #ff5b1f; animation: pc-blink 1.4s ease-in-out infinite; }
    @keyframes pc-blink { 50% { opacity: .3; } }
    @media (prefers-reduced-motion: reduce) { .dot { animation: none; } }
    .chip.wait { gap: 2px; padding: 2px 2px 2px 9px; border-radius: 999px; font-size: 11px; color: #d6cfc1; cursor: pointer;
      background: rgba(42,39,34,.8); box-shadow: 0 1px 4px rgba(0,0,0,.2); opacity: .7; transition: opacity .15s; }
    .chip.wait:hover, .chip.wait:focus-within { opacity: 1; }
    .chip.wait .note { display: flex; }
    .chip.wait .lcd, .chip.wait .go { display: none; }
    .chip.wait .x { width: 22px; height: 22px; font-size: 14px; border-radius: 50%; color: inherit; }
    :focus-visible { outline: 2px solid #ff5b1f; outline-offset: 2px; }
    @media (prefers-color-scheme: dark) {
      .chip { background: #0f0e0d; box-shadow: 0 0 0 1px #3f3c36, 0 2px 0 #000, 0 6px 16px rgba(0,0,0,.4); }
      .chip.wait { background: rgba(15,14,13,.8); box-shadow: 0 0 0 1px rgba(255,255,255,.12); }
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
    chip.setAttribute("aria-live", "polite");
    const note = doc.createElement("span");
    note.className = "note";
    const dot = doc.createElement("span");
    dot.className = "dot";
    note.append(dot, "Checking for a code");
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
    x = doc.createElement("button");
    x.className = "x";
    x.type = "button";
    x.textContent = "×";
    chip.append(note, lcd, key, x);
    shadow.append(style, chip);
    lcd.addEventListener("click", () => use());
    key.addEventListener("click", () => use());
    // waiting, there's nothing on it to press, so a click anywhere on it puts it away
    chip.addEventListener("click", (e) => { if (state === "waiting" || x.contains(e.target)) dismiss(true); });
    (doc.body || doc.documentElement).appendChild(host);
  }

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

  /** Shows the chip as `next` (waiting, code or link), or puts it away ("off"). */
  function show(next) {
    const was = state;
    state = next;
    if (next !== "waiting") clearTimeout(waitTimer);
    if (next === "off") {
      if (chip) chip.style.display = "none";
      if (host) delete host.dataset.state;
      return;
    }
    if (!chip) build();
    host.dataset.state = next;
    chip.classList.toggle("wait", next === "waiting");
    lcd.classList.toggle("link", next === "link");
    if (next === "waiting") {
      chip.title = x.title = "Hide on this site";
      x.setAttribute("aria-label", "Hide on this site");
      // it has said its piece after a while; the checks go on without it
      if (was !== "waiting") waitTimer = setTimeout(() => { if (state === "waiting") { waitDismissed = true; show("off"); } }, SHOW_WAIT);
    } else {
      chip.title = x.title = "";
      x.setAttribute("aria-label", "Dismiss");
      if (next === "link") {
        label.textContent = offer.host;
        sub.textContent = `Link from ${offer.from} · ${PC.ago(offer.at)}`;
        lcd.title = offer.link;
        key.textContent = "Open";
      } else {
        label.textContent = PC.group(offer.code);
        sub.textContent = offer.counter != null ? `${offer.from} · Duo passcode`
          : offer.totp ? `${offer.from} · authenticator · ${offer.left} s left` : `${offer.from} · ${offer.email} · ${PC.ago(offer.at)}`;
        lcd.title = "";
        key.textContent = "Fill";
      }
    }
    place();
  }

  function stop() { clearInterval(timer); checking = false; }

  /** Fills the code on offer, or opens the link on offer in a new tab. */
  function use() {
    if (!offer || !target) return false;
    if (offer.link) api.runtime.sendMessage({ type: "open", id: offer.id }).catch(() => {}); // the background opens it and counts it used
    else if (!PC.fill.fill(offer.code, [target])) return false;
    else if (offer.totp) {
      totpUsed = true; clearTimeout(totpTimer); // the box has it: no next code over the top of it
      // a Duo code is good until used, so the next sign-in needs the next one
      if (offer.counter != null) api.runtime.sendMessage({ type: "used", totp: offer.tid, counter: offer.counter }).catch(() => {});
    } else api.runtime.sendMessage({ type: "used", id: offer.id }).catch(() => {});
    dismissed.add(offer.id);
    offer = null;
    waitDismissed = true; // the box has its code: nothing more to wait for until a new box appears
    stop();
    show("off");
    return true;
  }

  /** Puts the chip away. `click`: with the mouse, which on the waiting tag also keeps it away from this site. */
  function dismiss(click) {
    if (state === "waiting" && click && SITE) {
      hushed = true;
      api.runtime.sendMessage({ type: "hush" }).catch(() => {});
    }
    if (offer) {
      dismissed.add(offer.id);
      if (offer.totp) { totpUsed = true; clearTimeout(totpTimer); } // and its next codes, for this box
    }
    waitDismissed = true; // a newer code or link still shows
    offer = null;
    show("off");
  }

  /** Whether codes for this box (or a link for this page) can still arrive by themselves, so checking is worth it. */
  async function canWait() {
    if (via === "app") return false;
    const accounts = await PC.store.get("accounts", []);
    if (via === "sms") return settings.forward || accounts.some((a) => a.kind === "texts");
    return accounts.some((a) => a.kind !== "texts");
  }

  /** This site's authenticator code now, as an offer, or null. */
  async function totpOffer() {
    clearTimeout(totpTimer);
    const r = await api.runtime.sendMessage({ type: "totp" }).catch(() => null);
    const t = r && r.codes && r.codes.find((c) => c.code);
    if (!t) return null;
    // a new code every period: look again as this one runs out (a Duo code has no clock)
    if (t.left != null) totpTimer = setTimeout(() => refresh().catch(() => {}), (t.left + 0.5) * 1000);
    return { id: `${t.id}:${t.code}`, tid: t.id, code: t.code, from: t.name, left: t.left, counter: t.counter, totp: true };
  }

  async function refresh() {
    settings = await PC.store.settings();
    // only the tab you're looking at takes a code: a box left open in a background tab mustn't use it up
    if (!settings.page || !target || doc.visibilityState !== "visible") { offer = null; clearTimeout(totpTimer); show("off"); return; }
    const now = Date.now();
    if (via === "app") offer = totpUsed ? null : await totpOffer();
    else {
      const codes = await PC.store.get("codes", []);
      const fresh = (c) => !c.used && !dismissed.has(c.id) && now - c.at < settings.fresh * PC.MIN;
      // a link page takes only a link that belongs with this site; a text prompt only codes that came by text; an
      // email prompt only codes that came by email
      offer = (via === "link" ? codes.find((c) => c.link && fresh(c) && PC.linkFor(c, SITE))
        : codes.find((c) => !c.link && fresh(c) && (via === "sms" ? c.via === "sms" : via === "email" ? c.via !== "sms" : true))) || null;
    }
    if (offer && dismissed.has(offer.id)) offer = null;
    if (offer && offer.link) { show("link"); return; } // a link is only ever opened by pressing Open
    if (offer) {
      if (settings.fill === "auto" && !filledAuto.has(offer.id)) {
        filledAuto.add(offer.id);
        if (use()) return;
      }
      show("code");
      return;
    }
    show(via !== "link" && checking && !waitDismissed && !hushed && (await canWait()) ? "waiting" : "off");
  }

  /** Fast checks while a code box (or a "we emailed you a link" page) is on screen, so the code shows up as soon
      as the email does. */
  function arm() {
    const now = Date.now();
    if (checking) return;
    // a new run of checks at most once a minute; a box that only blinked away and back picks up where it stopped
    if (now - armedAt >= 60e3) { armedAt = now; ticks = 0; }
    checking = true;
    clearInterval(timer);
    const tick = () => {
      if (!target || ticks >= (via === "link" ? LINK_WINDOW : WINDOW)) { stop(); refresh().catch(() => {}); return; }
      if (doc.visibilityState !== "visible") return;
      ticks++;
      api.runtime.sendMessage({ type: "poll", fast: true }).catch(() => {});
    };
    timer = setInterval(tick, 5000);
    tick();
    refresh().catch(() => {});
  }

  /** The block that says a link was emailed (fill.js's prompt), looked for at most every two seconds: it reads
      the page's text, and some pages never stop changing. */
  function linkPrompt() {
    const now = Date.now();
    if (now - promptAt < 2000) {
      setTimeout(later, 2050 - (now - promptAt));
      return promptEl && promptEl.isConnected ? promptEl : null;
    }
    promptAt = now;
    promptEl = PC.fill.prompt();
    return promptEl;
  }

  async function scan() {
    scanTimer = 0;
    settings = await PC.store.settings();
    const before = target;
    targets = settings.page ? PC.fill.find() : [];
    const active = doc.activeElement;
    let next = targets.find((t) => (t.el || null) === active || (t.els && t.els.includes(active))) || targets[0] || null;
    let how = next ? PC.fill.channel(next) : "";
    // Duo's own page never emails a code: a box there that isn't for a text is for a Duo passcode
    if (next && how !== "sms" && DUO_PAGE.test(g.location.hostname)) how = "app";
    // no code box: the page may say it emailed a link to click instead (not worth reading for without an inbox)
    if (!next && settings.page && (await PC.store.get("accounts", [])).some((a) => a.kind !== "texts")) {
      const el = linkPrompt();
      if (el) { next = { kind: "link", el }; how = "link"; }
    }
    target = next;
    via = how;
    hushed = (await PC.store.get("hush", [])).includes(SITE);
    // a box that wasn't there before (the next step of a sign-in) starts a fresh wait
    if (target && !before) {
      waitDismissed = false;
      totpUsed = false;
      if (await canWait()) arm();
    }
    if (!target) stop();
    await refresh();
  }
  function later() { if (!scanTimer) scanTimer = setTimeout(() => scan().catch(() => {}), 300); }

  new MutationObserver(later).observe(doc.documentElement, { childList: true, subtree: true });
  doc.addEventListener("focusin", later, true);
  doc.addEventListener("visibilitychange", () => refresh().catch(() => {}));
  doc.addEventListener("keydown", (e) => { if (e.key === "Escape" && state !== "off") dismiss(); }, true);
  g.addEventListener("scroll", schedulePlace, true);
  g.addEventListener("resize", schedulePlace);
  api.storage.onChanged.addListener((ch, area) => {
    if (area !== "local") return;
    if (ch.settings || ch.accounts || ch.authenticators || ch.hush) later();
    else if (ch.codes) refresh().catch(() => {});
  });
  scan().catch(() => {});
})(globalThis);
