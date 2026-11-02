/* AuthSkip: finding a page's code boxes and filling them. No messaging and no storage, so it can be injected on
   its own (the popup's Fill key and the Alt+Shift+F command inject util.js and this file into the active tab, once the
   click or key press has given the extension that tab) or loaded with offer.js on pages you opted in to.

   A code box is: an input that says autocomplete="one-time-code"; or a text, tel, number or password input whose
   name, id, placeholder, label or aria-label reads like a code (otp, verification, passcode, 2FA, security code…)
   unless it also reads like a card, coupon, zip or promo field; or four to ten one-character inputs in a row (the
   split boxes many sites draw). Filling goes through the input's native setter and fires input and change events,
   so React, Vue and plain forms all see it. */
(function (g) {
  const AS = (g.AS = g.AS || {});
  if (AS.fill) return;

  const OTP = /\b(?:otp|totp|one time|verif\w*|passcode|security code|auth\w* code|2fa|mfa|two factor|sms code|login code|sign in code|confirm\w* code|access code|pin|code)\b/i;
  const NOT = /\b(?:zip|postal|post|country|area|promo|coupon|discount|gift|referral|invite|voucher|cvv|cvc|card|expir\w*|search|tracking|captcha|barcode|qr|phone|email|username|user)\b/i;
  const TYPES = ["text", "tel", "number", "password", ""];

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
    return OTP.test(text) && !NOT.test(text);
  }

  /** Every code box on the page, in order: { kind: "one", el } or { kind: "split", els }. */
  function find(root) {
    root = root || g.document;
    const inputs = [...root.querySelectorAll("input")].filter(usable);
    const split = [];
    const taken = new Set();
    const singles = inputs.filter((i) => i.maxLength === 1);
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
    const one = inputs.filter((i) => !taken.has(i) && i.maxLength !== 1 && isCodeBox(i)).map((el) => ({ kind: "one", el }));
    return one.concat(split).sort((a, b) => {
      const ea = a.el || a.els[0], eb = b.el || b.els[0];
      return ea.compareDocumentPosition(eb) & 4 ? -1 : 1;
    });
  }

  function setVal(el, value) {
    el.focus();
    const proto = el instanceof g.HTMLTextAreaElement ? g.HTMLTextAreaElement.prototype : g.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new g.InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
    el.dispatchEvent(new g.Event("change", { bubbles: true }));
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

  AS.fill = { find, fill, visible, isCodeBox, setVal };
})(globalThis);
