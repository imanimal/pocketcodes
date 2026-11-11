/* PocketCodes: the inbox. Background only. Walks the accounts, asks each one's provider for the last half hour of
   mail it hasn't read yet, looks for a code in each message (codes.js), and keeps the codes it finds. Nothing about
   a message is stored except the code, the sender's name, the subject and the time; message bodies are read, searched
   and dropped. One writer for every storage key listed in util.js's header (this file), so reads never race it. */
(function (g) {
  const PC = (g.PC = g.PC || {});
  const api = PC.api;
  const MIN = PC.MIN;
  const LOOK_BACK = 30 * MIN;   // how far back each check looks
  const KEEP = 24 * 60 * MIN;   // how long a found code stays in the list
  const SEEN_CAP = 300;
  const CODES_CAP = 40;
  const provider = (a) => PC[a.kind];

  const accounts = () => PC.store.get("accounts", []);

  // ── accounts ──
  async function upsert(rec) {
    return PC.mutex("accounts", async () => {
      const list = await accounts();
      const i = list.findIndex((a) => a.id === rec.id);
      if (i >= 0) list[i] = Object.assign({}, list[i], rec);
      else list.push(Object.assign({ added: Date.now() }, rec));
      await PC.store.set("accounts", list);
      return list.find((a) => a.id === rec.id);
    });
  }

  /** Signs a Google or Microsoft account in (a new one, or `hint`'s again) and starts reading it. */
  async function addOAuth(kind, hint) {
    const p = PC[kind];
    const { email, tok } = await p.signIn(hint);
    if (!email) throw new Error("The sign-in didn't say which address it was for.");
    const id = `${kind}:${email}`;
    await PC.store.set("tok:" + id, tok);
    const acct = await upsert({ id, kind, email });
    await PC.store.del(["seen:" + id]);
    poll({ only: id, force: true });
    return acct;
  }

  /** Adds an IMAP account: the helper checks the login and keeps the password. */
  async function addImap({ preset, email, password, host, port, user }) {
    const pre = PC.imap.presets[preset] || PC.imap.presets.custom;
    email = String(email || "").trim().toLowerCase();
    host = String(host || pre.host || "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Enter the full email address.");
    if (!host) throw new Error("Enter the IMAP server, for example imap.example.com.");
    if (!password) throw new Error("Enter the password.");
    const id = `imap:${email}`;
    const rec = { id, kind: "imap", email, label: pre.label, host, port: Number(port) || pre.port || 993, user: String(user || "").trim() || email };
    const r = await PC.imap.add(rec, password);
    if (r && r.user) rec.user = r.user;
    const acct = await upsert(rec);
    await PC.store.del(["seen:" + id]);
    poll({ only: id, force: true });
    return acct;
  }

  /** Starts reading this Mac's texts, once the helper shows it can. */
  async function addTexts() {
    await PC.texts.check();
    const id = PC.texts.ID;
    const acct = await upsert({ id, kind: "texts", email: "Texts on this Mac", label: "Messages" });
    await PC.store.del(["seen:" + id]);
    poll({ only: id, force: true });
    return acct;
  }

  // ── authenticators: the keys live in the helper's vault; this list only says which site each one is for ──
  const authenticators = () => PC.store.get("authenticators", []);

  /** Adds an authenticator from its key or otpauth:// link. Resolves with { entry, code }. */
  async function addTotp({ key, name, site }) {
    const o = PC.codes.otpauth(key);
    if (!o) throw new Error("Paste the key the site shows under \"Can't scan the QR code?\", or its otpauth:// link.");
    site = PC.codes.site(site);
    if (!site) throw new Error("Enter the site it's for, for example github.com.");
    name = String(name || o.issuer || site).trim().slice(0, 60);
    const label = String(o.name || "").slice(0, 80);
    const id = `totp:${site}:${label || name}`.toLowerCase();
    const r = await PC.imap.call({ op: "totp-add", acct: id, secret: o.secret, digits: o.digits, period: o.period, algo: o.algo }, 10000);
    const entry = { id, name, site, label, digits: o.digits, period: o.period, added: Date.now() };
    await PC.mutex("authenticators", async () => {
      const list = (await authenticators()).filter((x) => x.id !== id);
      list.push(entry);
      await PC.store.set("authenticators", list);
    });
    return { entry, code: r.code };
  }

  /** Makes PocketCodes one more Duo Mobile device on an organization's Duo account, from Duo's "add a device" QR
      code or activation link. The helper activates it and keeps the key; resolves with { entry, code }. */
  async function addDuo({ link, name }) {
    const d = PC.codes.duo(link);
    if (!d) throw new Error("That isn't Duo's activation QR code or link. Right-click the QR code, copy its image link, and paste that.");
    const id = `duo:${d.host}`;
    const r = await PC.imap.call({ op: "duo-add", acct: id, host: d.host, code: d.code }, 30000);
    name = String(name || "").trim().slice(0, 60) || String(r.name || "").slice(0, 60) || "Duo";
    // the passcode box is on Duo's own page for the organization, so that's the site
    const entry = { id, kind: "duo", name, site: d.host, label: "", added: Date.now() };
    await PC.mutex("authenticators", async () => {
      const list = (await authenticators()).filter((x) => x.id !== id);
      list.push(entry);
      await PC.store.set("authenticators", list);
    });
    return { entry, code: r.code };
  }

  /** A Duo code (`counter`) was filled or copied, so the next one is due. From a page, only that page's own. */
  async function usedTotp(id, counter, page) {
    const x = (await authenticators()).find((a) => a.id === id);
    if (!x || x.kind !== "duo" || !Number.isInteger(counter)) return;
    if (page && !PC.codes.sameSite(new URL(page).hostname.toLowerCase(), x.site)) return;
    await PC.imap.call({ op: "hotp-used", acct: id, counter }, 8000);
  }

  async function removeTotp(id) {
    await PC.imap.remove(id);
    await PC.mutex("authenticators", async () => PC.store.set("authenticators", (await authenticators()).filter((x) => x.id !== id)));
  }

  /** The current codes of the authenticators for `host` (or the one `id`, or all): [{ id, name, site, label, code, left }],
      or for a Duo one { …, code, counter }: no clock, it holds until it's used. */
  async function totpCodes({ host, id } = {}) {
    const list = (await authenticators()).filter((x) => (id ? x.id === id : host ? PC.codes.sameSite(String(host).toLowerCase().replace(/^www\./, ""), x.site) : true));
    const out = [];
    for (const x of list) {
      try { out.push(Object.assign({}, x, await PC.imap.call({ op: "totp", acct: x.id }, 8000))); }
      catch (e) { out.push(Object.assign({}, x, { error: String((e && e.message) || e), nohost: e && e.code === "no-host" })); }
    }
    return out;
  }

  async function removeAccount(id) {
    const list = await accounts();
    const a = list.find((x) => x.id === id);
    if (!a) return;
    try { await provider(a).revoke(a); } catch (e) { /* the account goes either way */ }
    await PC.mutex("accounts", async () => PC.store.set("accounts", (await accounts()).filter((x) => x.id !== id)));
    await PC.store.del(["tok:" + id, "seen:" + id, "st:" + id]);
    await PC.mutex("codes", async () => PC.store.set("codes", (await PC.store.get("codes", [])).filter((c) => c.acct !== id)));
    await badge();
  }

  // ── reading ──
  const last = {};
  const inflight = {};

  async function readOne(a) {
    const seen = await PC.store.get("seen:" + a.id, []);
    const skip = new Set(seen);
    let msgs;
    try {
      msgs = await provider(a).fetchRecent(a, { since: Date.now() - LOOK_BACK, skip });
      await PC.store.set("st:" + a.id, { ok: true, at: Date.now() });
    } catch (e) {
      await PC.store.set("st:" + a.id, { ok: false, at: Date.now(), error: String((e && e.message) || e), auth: !!(e && e.auth), nohost: !!(e && e.code === "no-host") });
      return [];
    }
    const found = [];
    for (const m of msgs) {
      skip.add(m.key);
      const hit = PC.codes.find(m);
      if (!hit) continue;
      found.push({
        id: m.key, acct: a.id, email: a.email, kind: a.kind, code: hit.code, via: PC.texts.isText(a, m) ? "sms" : "email",
        from: PC.sender(m.from), subject: String(m.subject || "").slice(0, 140), at: m.at, found: Date.now(), seen: false, used: false,
      });
    }
    if (msgs.length) await PC.store.set("seen:" + a.id, [...skip].slice(-SEEN_CAP));
    return found;
  }

  async function keep(found) {
    return PC.mutex("codes", async () => {
      const cur = await PC.store.get("codes", []);
      const have = new Set(cur.map((c) => c.id));
      const fresh = found.filter((f) => !have.has(f.id));
      const now = Date.now();
      const next = fresh.concat(cur).filter((c) => now - c.at < KEEP).sort((a, b) => b.at - a.at).slice(0, CODES_CAP);
      // no write when nothing changed: every write wakes the popup and each sign-in page's chip
      if (next.length !== cur.length || next.some((c, i) => c.id !== cur[i].id)) await PC.store.set("codes", next);
      return fresh;
    });
  }

  /** Checks every account (or `only`), skipping any checked less than `gap` ms ago unless `force`. */
  async function poll({ only, force, fast } = {}) {
    const gap = force ? 0 : fast ? 2500 : 20e3;
    const todo = (await accounts()).filter((a) => (!only || a.id === only) && Date.now() - (last[a.id] || 0) >= gap);
    const found = [];
    let i = 0;
    const worker = async () => {
      while (i < todo.length) {
        const a = todo[i++];
        last[a.id] = Date.now();
        // one check per account at a time; a second caller waits for the first one's answer
        const run = inflight[a.id] || (inflight[a.id] = readOne(a).finally(() => { delete inflight[a.id]; }));
        found.push(...(await run));
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    const fresh = await keep(found);
    await PC.store.set("meta", { lastPoll: Date.now() });
    if (fresh.length) await announce(fresh);
    await badge();
    return fresh;
  }

  async function announce(fresh) {
    const s = await PC.store.settings();
    if (!s.notify || !api.notifications) return;
    const now = Date.now();
    for (const c of fresh) {
      if (now - c.at > 5 * MIN) continue;
      try {
        await api.notifications.create("code:" + c.id, {
          type: "basic", iconUrl: api.runtime.getURL("icons/icon-128.png"),
          title: `Code ${c.code}`, message: `${c.from} · ${c.email}${c.subject ? "\n" + c.subject : ""}`,
        });
      } catch (e) { /* notifications are a nicety */ }
    }
  }

  /** The newest code that is still fresh and unused, or undefined. */
  async function newest(codes, now) {
    const s = await PC.store.settings();
    return (codes || (await PC.store.get("codes", []))).find((c) => !c.used && (now || Date.now()) - c.at < s.fresh * MIN);
  }

  async function badge() {
    if (!api.action) return;
    const s = await PC.store.settings();
    const now = Date.now();
    const codes = await PC.store.get("codes", []);
    const n = codes.filter((c) => !c.seen && !c.used && now - c.at < s.fresh * MIN).length;
    const top = await newest(codes, now);
    try {
      await api.action.setBadgeText({ text: n ? String(n) : "" });
      if (api.action.setBadgeBackgroundColor) await api.action.setBadgeBackgroundColor({ color: "#2a4fa8" });
      await api.action.setTitle({ title: top ? `PocketCodes: ${top.code} from ${top.from}` : "PocketCodes" });
    } catch (e) { /* no toolbar button to update */ }
  }

  const mark = (field, ids) => PC.mutex("codes", async () => {
    const codes = await PC.store.get("codes", []);
    for (const c of codes) if (ids === "all" || ids.includes(c.id)) c[field] = true;
    await PC.store.set("codes", codes);
    await badge();
  });

  PC.inbox = { poll, addOAuth, addImap, addTexts, addTotp, addDuo, usedTotp, removeTotp, totpCodes, removeAccount, newest, badge, mark, readOne, keep, LOOK_BACK };
})(globalThis);
