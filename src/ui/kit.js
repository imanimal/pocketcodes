/* AuthSkip: the parts the popup and the settings page build (their classes are in ui/kit.css). Static parts are HTML
   strings, parts that listen are elements. The same parts as BetterWebWork's kit, so the Pocket apps look alike. */
(function (g) {
  const AS = (g.AS = g.AS || {}), esc = AS.esc;

  /** One element from an HTML string. */
  const el = (html) => AS.frag(String(html).trim()).firstElementChild;

  /** A key: { label, icon, cls, title, href, act, id, attrs, disabled }. Icon-only keys need a title (it's also the
      label). */
  function key(o) {
    const iconOnly = !o.label;
    const cls = `as-key${o.cls ? " " + o.cls : ""}${iconOnly ? " icon" : ""}`;
    const a = `class="${cls}"${o.title ? ` title="${esc(o.title)}"` : ""}${iconOnly ? ` aria-label="${esc(o.title || "")}"` : ""}${o.act ? ` data-act="${esc(o.act)}"` : ""}${o.id ? ` data-id="${esc(o.id)}"` : ""}${o.attrs ? " " + o.attrs : ""}`;
    const inner = `${o.icon ? AS.ic(o.icon) : ""}${o.label ? `<span class="as-kl">${esc(o.label)}</span>` : ""}`;
    return o.href ? `<a href="${esc(o.href)}" ${a}>${inner}</a>` : `<button type="button" ${a}${o.disabled ? " disabled" : ""}>${inner}</button>`;
  }

  /** A number with its label: a plain figure in Standard, an LCD inlay in Pocket. */
  const stat = (label, value, cls, small, title) =>
    `<div class="as-stat${cls ? " " + cls : ""} boot"${title ? ` title="${esc(title)}"` : ""}><span class="as-sl">${esc(label)}</span><span class="as-sn">${esc(value)}${small ? `<small>${esc(small)}</small>` : ""}</span></div>`;

  /** A small drawing of a theme, from its own tokens (the theme browser's cards and slots). */
  function preview(t) {
    const tk = t.tokens, v = ["bg", "bg2", "surface", "line", "text", "chrome-bg", "accent", "disp-bg"].map((k) => `--p-${k}:${tk[k]}`).join(";");
    return `<span class="as-tpv" data-look="${t.look}" style="${v}" aria-hidden="true"><span class="pv-card"><span class="pv-band"></span><span class="pv-l1"></span><span class="pv-l2"></span><span class="pv-in"></span><span class="pv-key"></span>${t.look === "pocket" ? '<span class="pv-lcd"></span>' : ""}</span></span>`;
  }

  /** A short message at the bottom right: toast("Copied", { action: "Undo", onAction, ms }). */
  function toast(msg, o = {}) {
    let box = document.querySelector(".as-toasts");
    if (!box) { box = el('<div class="as-toasts as-ui" role="status" aria-live="polite"></div>'); document.body.append(box); }
    const t = el(`<div class="as-toast"><span>${esc(msg)}</span>${o.action ? key({ label: o.action, cls: "ghost sm" }) : ""}</div>`);
    const done = () => t.remove();
    if (o.action) t.querySelector("button").addEventListener("click", () => { done(); o.onAction && o.onAction(); });
    box.append(t);
    setTimeout(done, o.ms || 3200);
    return t;
  }

  /** A key that asks twice: the first press arms it (label `ask`), a second within `ms` runs `fn`. */
  function twice(btn, ask, fn, ms = 4000) {
    if (btn.classList.contains("armed")) { btn.classList.remove("armed"); clearTimeout(btn._asT); fn(); return; }
    const lab = btn.querySelector(".as-kl"), was = lab ? lab.textContent : "";
    btn.classList.add("armed"); if (lab) lab.textContent = ask;
    btn._asT = setTimeout(() => { btn.classList.remove("armed"); if (lab) lab.textContent = was; }, ms);
  }

  /** Save a file the browser downloads. */
  function download(name, text, type = "application/json") {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = el(`<a download="${esc(name)}" href="${url}" hidden></a>`);
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  AS.kit = { el, key, stat, preview, toast, twice, download };
})(globalThis);
