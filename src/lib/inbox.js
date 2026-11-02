/* AuthSkip: the inbox. Background only. Walks the accounts, asks each one's provider for the last half hour of
   mail it hasn't read yet, looks for a code in each message (codes.js), and keeps the codes it finds. Nothing about
   a message is stored except the code, the sender's name, the subject and the time; message bodies are read, searched
   and dropped. One writer for every storage key listed in util.js's header (this file), so reads never race it. */
(function (g) {
  const AS = (g.AS = g.AS || {});
  const api = AS.api;
  const MIN = AS.MIN;
  const LOOK_BACK = 30 * MIN;   // how far back each check looks
  const KEEP = 24 * 60 * MIN;   // how long a found code stays in the list
  const SEEN_CAP = 300;
  const CODES_CAP = 40;
  const provider = (a) => AS[a.kind];

  const accounts = () => AS.store.get("accounts", []);

  // ── accounts ──
  async function upsert(rec) {
    return AS.mutex("accounts", async () => {
      const list = await accounts();
      const i = list.findIndex((a) => a.id === rec.id);
      if (i >= 0) list[i] = Object.assign({}, list[i], rec);
      else list.push(Object.assign({ added: Date.now() }, rec));
      await AS.store.set("accounts", list);
      return list.find((a) => a.id === rec.id);
    });
  }

  /** Signs a Google or Microsoft account in (a new one, or `hint`'s again) and starts reading it. */
  async function addOAuth(kind, hint) {
    const p = AS[kind];
    const { email, tok } = await p.signIn(hint);
    if (!email) throw new Error("The sign-in didn't say which address it was for.");
    const id = `${kind}:${email}`;
    await AS.store.set("tok:" + id, tok);
    const acct = await upsert({ id, kind, email });
    await AS.store.del(["seen:" + id]);
    poll({ only: id, force: true });
    return acct;
  }

  /** Adds an IMAP account: the helper checks the login and keeps the password. */
  async function addImap({ preset, email, password, host, port, user }) {
    const pre = AS.imap.presets[preset] || AS.imap.presets.custom;
    email = String(email || "").trim().toLowerCase();
    host = String(host || pre.host || "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Enter the full email address.");
    if (!host) throw new Error("Enter the IMAP server, for example imap.example.com.");
    if (!password) throw new Error("Enter the password.");
    const id = `imap:${email}`;
    const rec = { id, kind: "imap", email, label: pre.label, host, port: Number(port) || pre.port || 993, user: String(user || "").trim() || email };
    const r = await AS.imap.add(rec, password);
    if (r && r.user) rec.user = r.user;
    const acct = await upsert(rec);
    await AS.store.del(["seen:" + id]);
    poll({ only: id, force: true });
    return acct;
  }

  async function removeAccount(id) {
    const list = await accounts();
    const a = list.find((x) => x.id === id);
    if (!a) return;
    try { await provider(a).revoke(a); } catch (e) { /* the account goes either way */ }
    await AS.mutex("accounts", async () => AS.store.set("accounts", (await accounts()).filter((x) => x.id !== id)));
    await AS.store.del(["tok:" + id, "seen:" + id, "st:" + id]);
    await AS.mutex("codes", async () => AS.store.set("codes", (await AS.store.get("codes", [])).filter((c) => c.acct !== id)));
    await badge();
  }

  // ── reading ──
  const last = {};
  const inflight = {};

  async function readOne(a) {
    const seen = await AS.store.get("seen:" + a.id, []);
    const skip = new Set(seen);
    let msgs;
    try {
      msgs = await provider(a).fetchRecent(a, { since: Date.now() - LOOK_BACK, skip });
      await AS.store.set("st:" + a.id, { ok: true, at: Date.now() });
    } catch (e) {
      await AS.store.set("st:" + a.id, { ok: false, at: Date.now(), error: String((e && e.message) || e), auth: !!(e && e.auth), nohost: !!(e && e.code === "no-host") });
      return [];
    }
    const found = [];
    for (const m of msgs) {
      skip.add(m.key);
      const hit = AS.codes.find(m);
      if (!hit) continue;
      found.push({
        id: m.key, acct: a.id, email: a.email, kind: a.kind, code: hit.code,
        from: AS.sender(m.from), subject: String(m.subject || "").slice(0, 140), at: m.at, found: Date.now(), seen: false, used: false,
      });
    }
    if (msgs.length) await AS.store.set("seen:" + a.id, [...skip].slice(-SEEN_CAP));
    return found;
  }

  async function keep(found) {
    return AS.mutex("codes", async () => {
      const cur = await AS.store.get("codes", []);
      const have = new Set(cur.map((c) => c.id));
      const fresh = found.filter((f) => !have.has(f.id));
      const now = Date.now();
      const next = fresh.concat(cur).filter((c) => now - c.at < KEEP).sort((a, b) => b.at - a.at).slice(0, CODES_CAP);
      await AS.store.set("codes", next);
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
    await AS.store.set("meta", { lastPoll: Date.now() });
    if (fresh.length) await announce(fresh);
    await badge();
    return fresh;
  }

  async function announce(fresh) {
    const s = await AS.store.settings();
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
    const s = await AS.store.settings();
    return (codes || (await AS.store.get("codes", []))).find((c) => !c.used && (now || Date.now()) - c.at < s.fresh * MIN);
  }

  async function badge() {
    if (!api.action) return;
    const s = await AS.store.settings();
    const now = Date.now();
    const codes = await AS.store.get("codes", []);
    const n = codes.filter((c) => !c.seen && !c.used && now - c.at < s.fresh * MIN).length;
    const top = await newest(codes, now);
    try {
      await api.action.setBadgeText({ text: n ? String(n) : "" });
      if (api.action.setBadgeBackgroundColor) await api.action.setBadgeBackgroundColor({ color: "#2a4fa8" });
      await api.action.setTitle({ title: top ? `AuthSkip: ${top.code} from ${top.from}` : "AuthSkip" });
    } catch (e) { /* no toolbar button to update */ }
  }

  const mark = (field, ids) => AS.mutex("codes", async () => {
    const codes = await AS.store.get("codes", []);
    for (const c of codes) if (ids === "all" || ids.includes(c.id)) c[field] = true;
    await AS.store.set("codes", codes);
    await badge();
  });

  AS.inbox = { poll, addOAuth, addImap, removeAccount, newest, badge, mark, readOne, keep, LOOK_BACK };
})(globalThis);
