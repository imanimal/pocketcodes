/* PocketCodes: texts, read on a Mac. With Text Message Forwarding on (iPhone: Settings → Apps → Messages → Text
   Message Forwarding), every SMS the phone gets also lands in the Mac's Messages app, and the helper (host/) reads
   the newest ones out of Messages' own database, read-only. Free, and nothing leaves the Mac. Same provider shape
   as the inboxes: fetchRecent gives { key, from, subject, text, at }, keys t:<rowid>.
   Everywhere else, texts reach PocketCodes by being forwarded to an inbox it reads (an iPhone Shortcut or an
   Android forwarding app, with the subject FORWARD_SUBJECT), and inbox.js marks those codes as texts too. */
(function (g) {
  const PC = (g.PC = g.PC || {});

  PC.texts = {
    ID: "texts:mac",
    FORWARD_SUBJECT: "PocketCodes text",
    /** Whether a message (from any provider) is a text: read off the Mac, or forwarded with the agreed subject. */
    isText: (a, m) => a.kind === "texts" || /\bpocketcodes text\b/i.test(String((m && m.subject) || "")),
    /** Checks that the helper can read Messages here; throws its error (no-access, not-mac, no-host) if not. */
    check: () => PC.imap.call({ op: "texts", since: Date.now() - 60e3, limit: 1 }, 10000),
    async fetchRecent(a, { since, skip }) {
      const r = await PC.imap.call({ op: "texts", since, limit: 20 });
      return (r.messages || []).filter((m) => !skip.has(m.key));
    },
    revoke: async () => {},
  };
})(globalThis);
