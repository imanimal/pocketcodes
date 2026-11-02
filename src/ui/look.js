/* AuthSkip: the Look section of the settings page, the theme browser every Pocket app shares (BetterWebWork's
   settings.js): when to switch to night, then the Day and Night slots above the theme grid (a card fills the
   selected slot), then adjust colors, import and make a theme; and the typeface and motion.
   Every change saves at once (settings and themes are the two keys the pages write). Only the color editor has a Save
   key; while it's open it previews on the page and sets AS.previewing, which tells the page not to repaint over it.

   AS.look.panel(ctx) → { html(), click(el), change(el), input(el), key(e), toggle(e) }. ctx: { settings(), mine(),
   render() }. The event handlers return true when the event was theirs. */
(function (g) {
  const AS = g.AS, api = AS.api, T = AS.themes, K = AS.kit, esc = AS.esc;

  const NAMES = { bg: "Page", bg2: "Fields", surface: "Cards", surface2: "Wells and keys", line: "Lines", text: "Text and codes", text2: "Body text", text3: "Quiet text",
    "chrome-bg": "Bands", "chrome-fg": "Text on bands", accent: "Fill key", "on-accent": "Text on Fill", warn: "Going stale", bad: "Needs attention", "on-bad": "Text on attention",
    ok: "Fine", acc2: "Notes", "disp-bg": "LCD", "disp-fg": "LCD digits", "disp-hot": "LCD, going stale", "disp-bad": "LCD, error",
    k1: "Account 1", k2: "Account 2", k3: "Account 3", k4: "Account 4", k5: "Account 5", k6: "Account 6" };
  const MAIN = ["bg", "surface", "line", "text", "text2", "text3", "accent", "on-accent", "ok", "bad", "warn", "chrome-bg", "chrome-fg", "disp-bg", "disp-fg"];

  function panel(ctx) {
    const st = { slot: null, edit: null, idea: "", paste: "", note: null, open: {} };
    const S = () => ctx.settings();
    const all = () => T.BUILTIN.concat(ctx.mine());
    // icons in the look the page is about to show, not the one it showed a moment ago
    const as = () => (AS.previewing && st.edit ? st.edit.look : T.pick(S(), all()).look);
    const ic = (n, c) => AS.ic(n, c, as());
    const slotKey = () => (st.slot === "night" && S().night !== "off" ? "nightTheme" : "theme");
    const save = (patch) => AS.store.setSettings(patch);
    const saveThemes = (list) => api.storage.local.set({ themes: list });

    const chips = (name, value, opts, label, act = "lset") => `<div class="as-seg" role="radiogroup" aria-label="${esc(label)}">${opts.map(([v, l]) =>
      `<button type="button" class="as-chip${v === value ? " on" : ""}" role="radio" aria-checked="${v === value}" data-act="${act}" data-set="${name}" data-v="${esc(v)}" data-k="${act}-${name}-${esc(v)}">${esc(l)}</button>`).join("")}</div>`;

    function html() {
      const s = S();
      if (s.night === "off") st.slot = "day";
      else if (!st.slot) st.slot = T.isNight(s) ? "night" : "day";
      const find = (id) => all().find((t) => t.id === id);
      const nightOn = s.night !== "off", nowNight = nightOn && T.isNight(s);
      const dayT = find(s.theme) || T.BUILTIN[0], nightT = find(s.nightTheme) || T.byId("standard-dark");
      const sel = slotKey() === "nightTheme" ? s.nightTheme : s.theme;
      const slot = (which, t, label) => `<button type="button" class="as-slot${st.slot === which ? " on" : ""}" role="tab" aria-selected="${st.slot === which}" data-act="slot" data-v="${which}" data-k="slot-${which}">${K.preview(t)}<span class="as-sh">${ic(which === "night" ? "moon" : "today", "sm")}${label}${(which === "night") === nowNight ? '<span class="as-now">Now</span>' : ""}</span><span class="as-snm">${esc(t.name)}</span></button>`;
      const card = (t) => {
        const on = t.id === sel;
        return `<div class="as-tcard${on ? " on" : ""}" role="button" tabindex="0" aria-pressed="${on}" data-act="pick" data-id="${esc(t.id)}" data-k="t-${esc(t.id)}" title="${esc(t.note || t.name)}">${K.preview(t)}
          <span class="as-tn">${esc(t.name)}${t.scheme === "dark" ? `<span class="as-tmark">${ic("moon", "sm")}</span>` : ""}</span>
          <span class="as-tm">${t.look === "pocket" ? "Pocket" : "Standard"}${t.builtin ? "" : " · yours"}</span>
          <span class="as-tacts">${K.key({ icon: "palette", title: "Adjust colors", cls: "sm", act: "adjust", id: t.id })}${K.key({ icon: "download", title: "Export", cls: "sm", act: "export", id: t.id })}${t.builtin ? "" : K.key({ icon: "trash", title: "Delete", cls: "sm", act: "del", id: t.id })}</span></div>`;
      };
      const times = s.night === "schedule" ? `<div class="as-row2"><label class="as-color">From <input type="time" data-lset="nightFrom" value="${esc(s.nightFrom)}" data-k="from"></label><label class="as-color">until <input type="time" data-lset="nightTo" value="${esc(s.nightTo)}" data-k="to"></label></div>` : "";
      return `<div class="as-opt col"><div><b>Switch to a night theme</b></div>${chips("night", s.night, [["off", "Never"], ["auto", "With the system"], ["schedule", "On a schedule"], ["on", "Always"]], "Switch to a night theme")}${times}</div>
        ${nightOn ? `<div class="as-slots" role="tablist" aria-label="Theme slots">${slot("day", dayT, "Day")}${slot("night", nightT, "Night")}</div>` : ""}
        <div class="as-pickhd" style="margin:14px 0 8px">${nightOn ? (st.slot === "night" ? "Night theme" : "Day theme") : "Theme"}${nightOn ? "<span>Click a theme to put it in this slot.</span>" : ""}</div>
        <div class="as-themes">${all().map(card).join("")}</div>
        ${st.edit ? editor() : ""}${make()}
        <div class="as-opt col" style="margin-top:8px"><div><b>Typeface</b><span class="as-od">For the Standard look. Atkinson Hyperlegible tells 0 from O and 1 from l and I, which helps with codes that mix letters and digits. Pocket themes use Space Grotesk and Doto.</span></div>${chips("type", s.type, [["system", "Your system's font"], ["hyper", "Atkinson Hyperlegible"]], "Typeface")}</div>
        <div class="as-opt col"><div><b>Motion</b><span class="as-od">Motion also stays off when your system asks for reduced motion.</span></div>${chips("motion", s.motion, [["full", "On"], ["off", "Off"]], "Motion")}</div>`;
    }

    function editor() {
      const t = st.edit;
      const color = (k) => `<label class="as-color"><input type="color" value="${t.tokens[k]}" data-tok="${k}" data-k="tok-${k}"><span>${esc(NAMES[k])}</span></label>`;
      return `<div class="as-mod" id="as-editor" style="margin-top:16px">
        <div class="as-band"><span class="as-bt">${ic("palette")}Adjust colors</span><span class="as-sp"></span>${K.key({ icon: "close", title: "Cancel", cls: "ghost sm", act: "editCancel" })}</div>
        <div class="as-mb" style="display:flex;flex-direction:column;gap:14px">
          <label class="as-color">Name <input type="text" data-e="name" value="${esc(t.name)}" maxlength="48" style="flex:1" data-k="e-name"></label>
          <div class="as-row2">${chips("look", t.look, [["standard", "Standard"], ["pocket", "Pocket"]], "Look", "eset")}${chips("scheme", t.scheme, [["light", "Light"], ["dark", "Dark"]], "Scheme", "eset")}</div>
          <div class="as-colors">${MAIN.map(color).join("")}</div>
          <details class="as-more" data-d="allc"${st.open.allc ? " open" : ""}><summary>All colors</summary><div class="as-colors">${T.KEYS.filter((k) => !MAIN.includes(k)).map(color).join("")}</div></details>
          <div id="as-checks">${checks(t)}</div>
          <div class="as-row2">${K.key({ label: "Save theme", cls: "primary", act: "editSave" })}${K.key({ label: "Cancel", act: "editCancel" })}</div>
        </div></div>`;
    }
    const checks = (t) => {
      const bad = T.checks(t.tokens);
      return bad.length
        ? `<p class="as-note bad">Hard to read: ${bad.map((c) => `${esc(NAMES[c.f])} on ${esc(NAMES[c.b]).toLowerCase()} (${c.r.toFixed(1)}:1, needs ${c.min}:1)`).join("; ")}.</p><div class="as-row2" style="margin-top:6px">${K.key({ label: "Fix contrast", cls: "sm", act: "editFix" })}</div>`
        : '<p class="as-note">Every text color reads clearly on its background.</p>';
    };

    function make() {
      return `<details class="as-more" data-d="make" style="margin-top:16px"${st.open.make ? " open" : ""}><summary>Import or make a theme</summary><div>
        <p class="as-note">Themes are JSON files in the shared Pocket format, so one made for BetterWebWork, Collegiapp or PocketCanvas works here too.</p>
        <textarea class="as-code" data-f="paste" data-k="paste" placeholder="Paste a theme file, or a chatbot's whole reply" spellcheck="false">${esc(st.paste)}</textarea>
        <div class="as-row2">${K.key({ label: "Import", cls: "sm", act: "import" })}<label class="as-key sm ghost" data-k="file">${ic("download")}<span class="as-kl">Open a file</span><input type="file" accept=".json,application/json,text/plain" data-act="file" hidden></label></div>
        ${st.note ? `<p class="as-note${st.note.bad ? " bad" : ""}" role="status">${esc(st.note.t)}</p>` : ""}
        <div class="as-opt col" style="padding-bottom:0"><div><b>Make one with a chatbot</b><span class="as-od">Describe it, open the chatbot with the instructions filled in, then paste its reply above.</span></div>
          <input type="text" data-f="idea" data-k="idea" value="${esc(st.idea)}" placeholder="A calm blue for late nights">
          <div class="as-row2"><a class="as-key sm" data-k="bot" href="${esc(T.BOTS.claude(T.prompt(st.idea)))}" target="_blank" rel="noopener">${ic("ext")}<span class="as-kl">Open in Claude</span></a>${K.key({ label: "Copy the instructions", cls: "sm ghost", act: "copyPrompt" })}</div>
        </div></div></details>`;
    }

    // ── the color editor's live preview ──
    function preview() { AS.previewing = true; T.apply(st.edit, document.documentElement); }
    function stopPreview() { if (!AS.previewing) return; AS.previewing = false; T.look(S(), all(), document.documentElement); }

    function adjust(id) {
      const base = all().find((t) => t.id === id); if (!base) return;
      const t = JSON.parse(JSON.stringify(base));
      if (base.builtin) { delete t.builtin; let n = `${base.id}-edited`, i = 2; while (all().some((x) => x.id === n)) n = `${base.id}-edited-${i++}`; t.id = n; t.name = `${base.name} (edited)`; t.by = ""; }
      st.edit = t; preview(); ctx.render();
      const ed = document.getElementById("as-editor"); if (ed) ed.scrollIntoView({ block: "nearest" });
    }
    async function saveEdit() {
      const t = T.file(st.edit), mine = ctx.mine().slice(), at = mine.findIndex((x) => x.id === t.id);
      if (at >= 0) mine[at] = t; else mine.push(t);
      st.edit = null; AS.previewing = false;
      await saveThemes(mine);
      await save({ [slotKey()]: t.id });
      K.toast(`Saved ${t.name}`);
    }
    async function del(id) {
      const s = S(), patch = {};
      if (s.theme === id) patch.theme = AS.DEFAULTS.theme;
      if (s.nightTheme === id) patch.nightTheme = AS.DEFAULTS.nightTheme;
      await saveThemes(ctx.mine().filter((t) => t.id !== id));
      if (Object.keys(patch).length) await save(patch);
    }
    async function importText(text) {
      const r = T.normalize(text || "");
      st.open.make = true;
      if (r.error) { st.note = { bad: true, t: r.error }; ctx.render(); return; }
      const t = r.theme; let id = t.id, n = 2;
      while (all().some((x) => x.id === id)) id = `${t.id}-${n++}`;
      t.id = id;
      st.note = { t: `Imported ${t.name} as your ${slotKey() === "nightTheme" ? "night theme" : S().night === "off" ? "theme" : "day theme"}.${r.warnings.length ? " " + r.warnings.join(" ") : ""}` }; st.paste = "";
      await saveThemes(ctx.mine().concat(t));
      await save({ [slotKey()]: t.id });
    }
    const readFile = (input) => { const f = input.files && input.files[0]; input.value = ""; return f ? f.text() : Promise.resolve(null); };
    const copy = (text) => navigator.clipboard.writeText(text).then(() => K.toast("Copied. Paste it into any chatbot."), () => K.toast("Couldn't copy here. Use Open in Claude instead."));

    function click(b) {
      const id = b.dataset.id;
      switch (b.dataset.act) {
        case "lset": save({ [b.dataset.set]: b.dataset.v }); return true;
        case "slot": st.slot = b.dataset.v; ctx.render(); return true;
        case "pick": save({ [slotKey()]: id }); return true;
        case "adjust": adjust(id); return true;
        case "export": { const t = all().find((x) => x.id === id); if (t) K.download(`${t.id}.json`, JSON.stringify(T.file(t), null, 2)); return true; }
        case "del": K.twice(b, "Delete?", () => del(id)); return true;
        case "eset": st.edit[b.dataset.set] = b.dataset.v; preview(); ctx.render(); return true;
        case "editFix": st.edit = T.fix(st.edit); preview(); ctx.render(); return true;
        case "editSave": saveEdit(); return true;
        case "editCancel": st.edit = null; stopPreview(); ctx.render(); return true;
        case "import": importText(st.paste); return true;
        case "copyPrompt": copy(T.prompt(st.idea)); return true;
      }
      return false;
    }
    function change(t) {
      if (t.matches('input[type="time"][data-lset]')) { if (t.value) save({ [t.dataset.lset]: t.value }); return true; }
      if (t.matches('[data-act="file"]')) { readFile(t).then((x) => x != null && importText(x)); return true; }
      if (t.matches("[data-tok]")) { const c = document.getElementById("as-checks"); if (c) c.replaceChildren(AS.frag(checks(st.edit))); return true; }
      return false;
    }
    function input(t) {
      if (t.matches("[data-tok]")) { st.edit.tokens[t.dataset.tok] = t.value; preview(); return true; }
      if (t.matches('[data-e="name"]')) { st.edit.name = t.value; return true; }
      if (t.matches('[data-f="idea"]')) { st.idea = t.value; const a = document.querySelector('[data-k="bot"]'); if (a) a.href = T.BOTS.claude(T.prompt(st.idea)); return true; }
      if (t.matches('[data-f="paste"]')) { st.paste = t.value; return true; }
      return false;
    }
    function key(e) {
      if ((e.key === "Enter" || e.key === " ") && e.target.matches(".as-tcard")) { e.preventDefault(); save({ [slotKey()]: e.target.dataset.id }); return true; }
      return false;
    }
    const toggle = (e) => { if (e.target.dataset && e.target.dataset.d) st.open[e.target.dataset.d] = e.target.open; };
    /** Whether something is being typed or edited here, so a repaint from storage should wait. */
    const busy = () => !!st.edit;

    return { html, click, change, input, key, toggle, busy, stopPreview };
  }

  AS.look = { panel, NAMES };
})(globalThis);
