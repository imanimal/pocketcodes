/* PocketCodes: finding a page's code boxes and filling them. No messaging and no storage, so it can be injected on
   its own (the popup's Fill key and the Alt+Shift+F command inject util.js and this file into the active tab, once the
   click or key press has given the extension that tab) or loaded with offer.js on pages you opted in to.

   A code box is: an input that says autocomplete="one-time-code"; or a text, tel, number or password input whose
   name, id, placeholder, label or aria-label reads like a code (otp, otc, verification, passcode, 2FA, security
   code…) unless it also reads like a card, coupon, zip or promo field; or a bare numeric box (inputmode, pattern or
   tel/number type, 4 to 8 long) that is the only one in its form or dialog and that form's own text asks for a code;
   or four to ten one-character (or narrow numeric) inputs in a row, the split boxes many sites draw. Open shadow
   roots are searched too. Filling goes through the input's native setter and fires input and change events, so
   React, Vue and plain forms all see it. Nothing read here leaves the page. */
(function (g) {
  const PC = (g.PC = g.PC || {});
  if (PC.fill) return;

  const OTP = /\b(?:otp|otc|totp|one time|verif\w*|passcode|security code|auth\w* code|2fa|mfa|two factor|sms code|login code|sign in code|confirm\w* code|access code|pin|code)\b/i;
  const NOT = /\b(?:zip|postal|post|country|area|promo|coupon|discount|gift|referral|invite|voucher|cvv|cvc|card|expir\w*|search|tracking|captcha|barcode|qr|phone|email|username|user)\b/i;
  const TYPES = ["text", "tel", "number", "password", ""];
  // what the form around a bare numeric box has to say, and what rules it out
  const ASK = /\b(?:(?:\d|four|six|eight) digit|code|otp|passcode|one time|verif\w*|two (?:factor|step)|2fa|authenticat\w*)\b/i;
  const NOT_ASK = /\b(?:promo|coupon|discount|gift|referral|voucher|card number|zip|postal|quantity)\b/i;

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

  /** The form, dialog or section a box sits in, and its text (capped), for a box that says nothing about itself. */
  function around(el) {
    const box = el.closest("form, [role=dialog], dialog, section, fieldset") || (el.parentElement && el.parentElement.parentElement);
    return box ? [box, norm(String(box.textContent || "").slice(0, 800))] : [null, ""];
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

  PC.fill = { find, fill, visible, isCodeBox, setVal };
})(globalThis);
