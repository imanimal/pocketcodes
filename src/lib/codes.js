/* AuthSkip: finding the code in a message. Pure functions on globalThis.AS.codes, no browser APIs, so the tests
   (tests/core.test.js) run them in Node. The rules, in the order they apply:

   1. A message is only searched if some line mentions a code word (code, OTP, passcode, PIN, one-time password,
      token). Newsletters, receipts and shipping notices never get a candidate.
   2. Candidates are: Google's "G-123456" (the digits), six or eight digits grouped as "123 456" or "1234-5678" (the
      group is joined), plain runs of 4 to 8 digits, and 5 to 8 upper-case letters and digits that mix both (Steam
      Guard style). Digits inside URLs, email addresses, dates, amounts, phone numbers and "#123" are not candidates.
   3. Each candidate is scored by how close the nearest code word is (before it counts more than after), whether it
      follows "is" or a colon, whether it sits alone on its line (the subject counts as a line), and whether it is 6
      long. It loses points for order, invoice and tracking words just before it, promo words around it, a time unit
      after it ("3600 seconds"), "expires in" before it, and for looking like a year next to a copyright line.
   4. The best candidate at 30 points or more wins; the rest come back as alternatives.

   Every rule has a case in tests/core.test.js, and so do the quiet cases (messages that must give nothing). */
(function (g) {
  const AS = (g.AS = g.AS || {});

  const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', copy: "©" };

  /** HTML mail as plain text, with block ends as line breaks so "a code on its own line" still shows. */
  function htmlToText(html) {
    return String(html || "")
      .replace(/<(style|script|head|title)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6]|table|section|blockquote)>/gi, "\n")
      .replace(/<\/t[dh]>/gi, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
        if (e[0] === "#") {
          const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
          return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " ";
        }
        return NAMED[e.toLowerCase()] || " ";
      });
  }

  // Built from char codes so no raw line-separator characters or escapes sit in the source.
  const ch = (n) => String.fromCharCode(n);
  const INVISIBLE = new RegExp("[" + ch(0x200b) + "-" + ch(0x200f) + ch(0x2028) + ch(0x2029) + ch(0x2060) + ch(0xfeff) + ch(0xad) + ch(0x34f) + "]", "g");
  const SPACEY = new RegExp("[" + ch(0xa0) + ch(0x2007) + ch(0x202f) + "]", "g");

  /** Tidies text for searching: invisible characters gone, spaces collapsed, URLs and addresses blanked out. */
  function clean(text) {
    return String(text || "")
      .replace(INVISIBLE, "")
      .replace(SPACEY, " ")
      .replace(/\r/g, "")
      .replace(/(?:https?:\/\/|www\.)\S+/gi, " ")
      .replace(/[^\s<>"]+@[^\s<>"]+\.[a-z]{2,}/gi, " ")
      .replace(/[ \t\f\v]+/g, " ")
      .replace(/ ?\n ?/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  const WORD = /\b(?:code|codes|otp|passcode|pin|password|token|passkey)\b/gi;
  const NEG = /(?:order|invoice|tracking|account|acct|phone|call|zip|postal|reference|ref|ticket|receipt|amount|total|balance|case|id|number|no\.?|#|ext\.?)\s*[:#]?\s*$/i;
  const PROMO = /(?:discount|coupon|promo|save\s+\d|% off|off your|checkout|on sale|free shipping|redeem|voucher|gift card)/i;
  const UNIT = /^\s*(?:sec|second|min|minute|hour|hr|day|week|%|percent|points|pts|usd|eur|dollars|\$)/i;
  const WINDOW = /(?:expires?\s+in|valid\s+for|within|lasts?\s+for|for\s+the\s+next)\s*$/i;
  const MONTH = /(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d{0,2},?\s*$|(?:©|\(c\)|copyright)\s*$/i;

  // The characters just before and after a candidate that rule it out (dates, money, phone numbers, ids, decimals).
  const BEFORE_OK = "(?<![\\w.,$€£#+\\-/@]|\\d[ -])";
  const AFTER_OK = "(?![\\w@/]|-\\d|[.,]\\d|\\s?%)";

  function lineOf(text, start, end) {
    const a = text.lastIndexOf("\n", start - 1) + 1;
    let b = text.indexOf("\n", end);
    if (b < 0) b = text.length;
    return text.slice(a, b);
  }

  function candidates(text) {
    const out = [];
    const add = (re, pick) => {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        const c = pick(m);
        if (c) out.push(Object.assign({ start: m.index, end: m.index + m[0].length, raw: m[0] }, c));
      }
    };
    add(/\bG-(\d{6})\b/g, (m) => ({ code: m[1], kind: "google", bonus: 60 }));
    add(new RegExp(BEFORE_OK + "(\\d{3})[ -](\\d{3})(?![\\w@/]|[ -]\\d|[.,]\\d|\\s?%)", "g"), (m) => ({ code: m[1] + m[2], kind: "digits", bonus: 0 }));
    add(new RegExp(BEFORE_OK + "(\\d{4})[ -](\\d{4})(?![\\w@/]|[ -]\\d|[.,]\\d|\\s?%)", "g"), (m) => ({ code: m[1] + m[2], kind: "digits", bonus: 0 }));
    add(new RegExp(BEFORE_OK + "(\\d{4,8})" + AFTER_OK, "g"), (m) => ({ code: m[1], kind: "digits", bonus: 0 }));
    add(new RegExp(BEFORE_OK + "([A-Z0-9]{5,8})" + AFTER_OK, "g"), (m) => {
      const s = m[1];
      if (/^\d+$/.test(s)) return null;              // the digits-only rule has these
      if (/[0-9]/.test(s) && /[A-Z]/.test(s)) return { code: s, kind: "mixed", bonus: -8 };
      return { code: s, kind: "letters", bonus: -8 }; // only accepted alone on a line below a "code" line (see score)
    });
    // keep the first of any two that overlap (the grouped forms come before the plain runs)
    const kept = [];
    for (const c of out) if (!kept.some((k) => c.start < k.end && k.start < c.end)) kept.push(c);
    return kept;
  }

  function score(text, c) {
    const before = text.slice(Math.max(0, c.start - 90), c.start);
    const after = text.slice(c.end, c.end + 50);
    let s = c.bonus;

    let near = 0;
    WORD.lastIndex = 0;
    let w, lastEnd = -1;
    while ((w = WORD.exec(before))) lastEnd = w.index + w[0].length;
    if (lastEnd >= 0) near = 50 - Math.min(before.length - lastEnd, 90) * 0.4;
    WORD.lastIndex = 0;
    const wa = WORD.exec(after);
    if (wa) near = Math.max(near, 30 - Math.min(wa.index, 50) * 0.4);
    s += near;

    const line = lineOf(text, c.start, c.end).trim();
    const alone = line === c.raw || line.replace(/[\s:.\-–—*"'`>()[\]]/g, "") === c.raw.replace(/[\s-]/g, "");
    if (alone) s += 15;
    if (/(?:\bis|[:=\-–—])\s*["'*`(\[]*$/i.test(before)) s += 10;
    const len = c.code.length;
    s += len === 6 ? 8 : len === 4 ? 4 : len === 8 ? 3 : 2;

    // letters-only tokens are only believable alone on a line right under a line that mentions a code
    if (c.kind === "letters") {
      const prev = text.slice(0, text.lastIndexOf("\n", c.start - 1)).split("\n").pop() || "";
      if (!alone || !/\bcode\b/i.test(prev)) return -1;
      s += 12;
    }

    const tail = before.slice(-25);
    WORD.lastIndex = 0;
    if (NEG.test(tail) && !WORD.test(tail)) s -= 45;
    if (PROMO.test(text.slice(Math.max(0, c.start - 60), c.end + 60))) s -= 50;
    if (UNIT.test(after)) s -= 50;
    if (WINDOW.test(before)) s -= 50;
    if (c.kind === "digits" && c.code.length === 4 && /^(?:19|20)\d\d$/.test(c.code) && MONTH.test(before)) s -= 60;
    return s;
  }

  /** Every candidate code in the message, best first: [{ code, score, kind }]. */
  function all(msg) {
    const subject = String((msg && msg.subject) || "");
    const body = String((msg && msg.text) || "");
    const text = clean(subject + "\n" + body);
    WORD.lastIndex = 0;
    if (!WORD.test(text)) return [];
    const list = [];
    const seen = new Set();
    for (const c of candidates(text)) {
      const sc = score(text, c);
      if (sc < 30 || seen.has(c.code)) continue;
      seen.add(c.code);
      list.push({ code: c.code, score: Math.round(sc), kind: c.kind });
    }
    return list.sort((a, b) => b.score - a.score);
  }

  /** The best code in { subject, text }, or null. */
  function find(msg) { return all(msg)[0] || null; }

  AS.codes = { htmlToText, clean, all, find };
})(globalThis);
