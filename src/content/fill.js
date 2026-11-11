/* PocketCodes: finding a page's code boxes and filling them. No messaging and no storage, so it can be injected on
   its own (the popup's Fill key and the Alt+Shift+F command inject util.js and this file into the active tab, once the
   click or key press has given the extension that tab) or loaded with offer.js on pages you opted in to.

   A code box is: an input that says autocomplete="one-time-code"; or a text, tel, number or password input whose
   name, id, placeholder, label or aria-label reads like a code (otp, otc, verification, passcode, 2FA, security
   code…) unless it also reads like a card, coupon, zip or promo field; or a bare numeric box (inputmode, pattern or
   tel/number type, 4 to 8 long) that is the only one in its form or dialog and that form's own text asks for a code;
   or four to ten one-character (or narrow numeric) inputs in a row, the split boxes many sites draw. Open shadow
   roots are searched too. Filling goes through the input's native setter and fires input and change events, so
   React, Vue and plain forms all see it.
   channel(target) says how the page sent the code, from the box's own attributes and then the text around it (the
   largest block around the box under 1500 characters, or the first one holding its heading that says how):
   "email", "sms" (a text to a phone) or "app" (an authenticator), whichever the text names first, or "" when it
   doesn't say. Nothing read here leaves the page. */
(function (g) {
  const PC = (g.PC = g.PC || {});
  if (PC.fill) return;

  const OTP = /\b(?:otp|otc|totp|one time|verif\w*|passcode|security code|auth\w* code|2fa|mfa|two factor|sms code|login code|sign in code|confirm\w* code|access code|pin|code)\b/i;
  const NOT = /\b(?:zip|postal|post|country|area|promo|coupon|discount|gift|referral|invite|voucher|cvv|cvc|card|expir\w*|search|tracking|captcha|barcode|qr|phone|email|username|user)\b/i;
  const TYPES = ["text", "tel", "number", "password", ""];
  // what the form around a bare numeric box has to say, and what rules it out
  const ASK = /\b(?:(?:\d|four|six|eight) digit|code|otp|passcode|one time|verif\w*|two (?:factor|step)|2fa|authenticat\w*)\b/i;
  const NOT_ASK = /\b(?:promo|coupon|discount|gift|referral|voucher|card number|zip|postal|quantity)\b/i;

  // how the code was sent. Bare "phone" and "mobile" aren't enough ("your phone's authenticator app", "mobile app")
  const VIA = {
    email: /\b(?:e ?mail(?:ed)?|inbox)\b|[^\s@]+@[^\s@]+\.[a-z]{2,}/i,
    sms: /\b(?:sms|texted|text(?:ed)? (?:message|you)|(?:a|by|via) text|sent (?:\w+ ){0,5}to (?:your )?(?:phone|mobile|cell)|(?:phone|mobile|cell)(?: phone)? number|(?:phone|number) ending)\b|(?:\+\d{1,3}[\s.-]?)?\(?[•*x]{3}\)?[\s.-]?[•*x]{3}[\s.-]?[•*x]{0,2}\d{2,4}\b/i,
    app: /\b(?:authenticator|authentication app|auth app|authy|duo mobile|totp|code generator|(?:your|the|an?) (?:\w+ ){0,2}(?:security |authentication |2fa |mfa |verification )?app\b(?! store))/i,
  };
  const HEADING = "h1, h2, h3, h4, h5, h6, [role=heading], legend";

  const norm = (s) => String(s || "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_\-.[\]:]+/g, " ").toLowerCase();

  function visible(el) {
    if (!el.isConnected || el.getClientRects().length === 0) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) return false;
    const cs = g.getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
  }

  function labelText(el) {
    const out = [];
    for (const l of el.labels || []) out.push(l.textContent);
    const by = el.getAttribute("aria-labelledby");
    if (by) for (const id of by.split(/\s+/)) { const n = el.ownerDocument.getElementById(id); if (n) out.push(n.textContent); }
    return out.join(" ");
  }

  const numeric = (el) => (el.getAttribute("inputmode") || "").toLowerCase() === "numeric" || /\[0-9\]|\\d/.test(el.getAttribute("pattern") || "") || /^(tel|number)$/i.test(el.getAttribute("type") || "");

  /** An element's text with a space between its pieces ("Check your email" + "Enter the code" stay two phrases),
      without scripts and styles, cut off a little past 1500 characters. */
  function textOf(n) {
    const w = n.ownerDocument.createTreeWalker(n, 4 /* text nodes */);
    let s = "", x;
    while ((x = w.nextNode()) && s.length <= 1600) {
      if (!/^(?:SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(x.parentNode.nodeName)) s += " " + x.nodeValue;
    }
    return s.replace(/\s+/g, " ").trim();
  }

  /** The form, dialog or section a box sits in, and its text (capped), for a box that says nothing about itself. */
  function around(el) {
    const box = el.closest("form, [role=dialog], dialog, section, fieldset") || (el.parentElement && el.parentElement.parentElement);
    return box ? [box, norm(textOf(box).slice(0, 800))] : [null, ""];
  }

  /** Every input under root, through open shadow roots. */
  function inputs(root) {
    const out = [...root.querySelectorAll("input")];
    for (const el of root.querySelectorAll("*")) if (el.shadowRoot) out.push(...inputs(el.shadowRoot));
    return out;
  }

  function usable(el) {
    return TYPES.includes((el.getAttribute("type") || "text").toLowerCase()) && !el.disabled && !el.readOnly && visible(el);
  }

  function isCodeBox(el) {
    const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
    if (ac.includes("one-time-code")) return true;
    if (/(^|\s)(cc-|current-password|new-password|username|email|tel|street|postal|name|bday)/.test(ac)) return false;
    const ml = el.maxLength;
    if (ml > 0 && (ml < 4 || ml > 10)) return false;
    const text = norm([el.name, el.id, el.placeholder, el.getAttribute("aria-label"), el.getAttribute("data-testid"), labelText(el)].join(" "));
    if (NOT.test(text)) return false;
    if (OTP.test(text)) return true;
    // a bare numeric box counts only when it's the one such box around and the text there asks for a code
    if (!numeric(el) || ml > 8) return false;
    const [box, said] = around(el);
    if (!box || !ASK.test(said) || NOT_ASK.test(said)) return false;
    return ![...box.querySelectorAll("input")].some((i) => i !== el && usable(i) && !cell(i) && numeric(i));
  }

  /** One cell of a split code: one character long, or a narrow numeric box with no length set. */
  const cell = (el) => el.maxLength === 1 || (el.maxLength < 0 && numeric(el) && el.getBoundingClientRect().width <= 64);

  /** Every code box on the page, in order: { kind: "one", el } or { kind: "split", els }. */
  function find(root) {
    root = root || g.document;
    const all = inputs(root).filter(usable);
    const split = [];
    const taken = new Set();
    const singles = all.filter(cell);
    for (const up of [1, 2]) {
      const byParent = new Map();
      for (const i of singles) {
        if (taken.has(i)) continue;
        let p = i;
        for (let n = 0; n < up && p; n++) p = p.parentElement;
        if (!p) continue;
        if (!byParent.has(p)) byParent.set(p, []);
        byParent.get(p).push(i);
      }
      for (const els of byParent.values()) {
        if (els.length >= 4 && els.length <= 10) { split.push({ kind: "split", els }); els.forEach((e) => taken.add(e)); }
      }
    }
    const one = all.filter((i) => !taken.has(i) && !cell(i) && isCodeBox(i)).map((el) => ({ kind: "one", el }));
    return one.concat(split).sort((a, b) => {
      const ea = a.el || a.els[0], eb = b.el || b.els[0];
      return ea.compareDocumentPosition(eb) & 4 ? -1 : 1;
    });
  }

  /** "email", "sms" or "app": the one the text names first, or "". */
  function first(text) {
    let pick = "", at = Infinity;
    for (const k in VIA) { const m = VIA[k].exec(text); if (m && m.index < at) { pick = k; at = m.index; } }
    return pick;
  }

  /** The text of the block around the target: the largest that holds no other text box and stays under 1500
      characters (its heading and help text, but not a newsletter form in the footer), or a smaller one that already
      holds a heading above the box and says how the code came, so a header's "get the app" can't outvote it. React
      pages wrap a box deep (Stripe's heading is 9 levels up, PayPal's 10), so the climb goes up to 24. */
  function context(t) {
    const mine = t.el ? [t.el] : t.els;
    // up through the elements, and out of a shadow root to its host
    const up = (x) => x.parentElement || (x.parentNode && x.parentNode.host) || null;
    let best = "", from = mine[0], n = up(from);
    for (let i = 0; i < 24 && n && n !== mine[0].ownerDocument.documentElement; i++, from = n, n = up(n)) {
      const text = textOf(n);
      if (text.length > 1500 || [...n.querySelectorAll("input")].some((x) => !mine.includes(x) && usable(x))) break;
      best = text;
      if (first(text) && [...n.querySelectorAll(HEADING)].some((h) => h.compareDocumentPosition(from) & 4 /* box after it */)) break;
    }
    return best;
  }

  /** How the code was sent, from the text around the box. Bare words in the box's attributes win outright. */
  function channel(t) {
    const el = t.el || t.els[0];
    const own = norm([el.name, el.id, el.placeholder, el.getAttribute("aria-label"), labelText(el)].join(" "));
    return first(own.replace(/\b(?:email|sms|text|app)\b/g, (w) => ({ email: "email", sms: "sms", text: "text message", app: "authenticator" })[w])) || first(context(t));
  }

  function setVal(el, value) {
    el.focus();
    const proto = el instanceof g.HTMLTextAreaElement ? g.HTMLTextAreaElement.prototype : g.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    // composed, as typed input is, so listeners outside a web component's shadow root hear it too
    el.dispatchEvent(new g.InputEvent("input", { bubbles: true, composed: true, data: value, inputType: "insertText" }));
    el.dispatchEvent(new g.Event("change", { bubbles: true, composed: true }));
  }

  const holds = (t, node) => !!node && (t.kind === "one" ? t.el === node : t.els.includes(node));

  /** Fills `code` into the code box that has focus, else the first one. Returns true if something was filled. */
  function fill(code, targets) {
    targets = targets || find();
    if (!targets.length) return false;
    const active = g.document.activeElement;
    const t = targets.find((x) => holds(x, active)) || targets[0];
    code = String(code).replace(/\s+/g, "");
    if (t.kind === "split") {
      t.els.forEach((el, i) => { if (code[i]) setVal(el, code[i]); });
      t.els[Math.min(code.length, t.els.length) - 1].focus();
    } else {
      setVal(t.el, t.el.maxLength > 0 ? code.slice(0, t.el.maxLength) : code);
    }
    return true;
  }

  PC.fill = { find, fill, visible, isCodeBox, setVal, channel };
})(globalThis);
