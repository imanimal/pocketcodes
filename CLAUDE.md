# AuthSkip: notes for Claude

A Firefox and Chrome MV3 extension (one source tree, one manifest) that collects one-time codes from any number of Gmail, Outlook and IMAP (iCloud, Yahoo, Fastmail, custom) inboxes into one list, with one-click fill. The product is AuthSkip; the GitHub repo is still named `imanimal/pocketcodes` (the old name). Sibling of BetterWebWork, Collegiapp and PocketCanvas (`../betterwebwork`, `../collegiapp`, `../pocketcanvas`); same conventions, same themes. The user is a UCSB CS student on Windows 11 + Mac who has only Google and iCloud accounts.

## Invariants

- **Reads only.** Gmail scope is `gmail.readonly`, Graph scope `Mail.Read`, IMAP uses `EXAMINE` and `BODY.PEEK`. Nothing is ever sent, deleted, flagged or marked read. Message bodies are searched and dropped; only the code, sender name, subject and time are kept.
- **Unlimited accounts, no server.** Google and Microsoft sign in per account through `identity.launchWebAuthFlow` (authorization code + PKCE) against the user's own OAuth client (entered in Settings, never in the repo). One refresh token per account in `tok:<id>`. `$0`: no paid services.
- **Single writer.** Only the background script (`inbox.js`) writes `accounts`, `tok:*`, `seen:*`, `st:*`, `codes`, `meta`; pages read storage and send messages (`background.js` `handlers`). The pages write only `settings`, `themes`, `google`, `microsoft`. The key list is in `src/lib/util.js`'s header.
- **IMAP goes through the helper.** An extension can't open IMAP sockets, so `host/authskip_host.py` (stdlib Python, native messaging, installed once by `host/install_host.py`) logs in, checks the password, and keeps it in the OS vault (Windows DPAPI via ctypes, macOS Keychain via `security`, Linux 0600 file). The extension never stores an IMAP password. The wire format is in `src/lib/imap.js`'s header: requests `{id, op, ...}`, answers `{re, ok|error, auth?, code?}`; ops `hello`, `add`, `remove`, `poll`.
- **Providers share one shape.** `{ signIn, fetchRecent(account, {since, skip}), revoke }`; `fetchRecent` returns `{key, from, subject, text, at}` for messages whose key isn't in `skip`. Keys: `g:<id>`, `m:<id>`, `i:<acct>:<uidvalidity>:<uid>`. New provider = new file with that shape plus a branch in `inbox.js`/options.
- **Pure parts are tested.** `src/lib/codes.js` (extraction) has no browser APIs; every rule has a case in `tests/core.test.js`, and the quiet cases (messages that must give nothing) too. Change a rule, add a case.
- **Buildless.** Classic scripts on `globalThis.AS`, no npm, no bundler. Keep in step: the manifest's background `scripts`, `background.js`'s `importScripts` (Chrome's service worker), the `<script>` tags in `src/pages/*.html`, and the registered content script list in `background.js` `registerPage` (`util`, `themes`, `fill`, `offer`; re-registered on every update).
- **Two browsers, one tree.** `manifest.json` loads unpacked in Firefox 128+ and Chrome 111+ as it is (Firefox runs `background.scripts`, Chrome the `service_worker`). `tools/build.py` writes each browser's zip; it drops `key` from the Firefox one. The manifest `key` pins the Chrome extension ID (`kammpeiopjjhipmdggclkefddnlagnpk`) so the OAuth redirect URI and the helper's `allowed_origins` stay stable; Firefox's ID is `authskip@imanimal.github.io`. Never type `\uXXXX` escapes into files through some tools: they get turned into raw characters. `codes.js` builds its invisible-character classes from `String.fromCharCode`.
- **No flash of permissions.** The only host permissions are the four API hosts. The all-sites permission is optional, asked on the options page when the user turns on "Offer codes on sign-in pages", and registers `util.js` + `themes.js` + `fill.js` + `offer.js` with `scripting.registerContentScripts`. Without it, Fill works on the current tab through `activeTab` (popup key, Alt+Shift+F).
- **Human, plain UI, then themes.** The default is the Standard look: sentence case, system fonts, flat surfaces, no gradients, glow or emoji, and one accent that only means "do this" (Fill). Then theme options, the Pocket apps' shared system: `src/lib/themes.js` (the shared Pocket theme format, built-ins Standard / Standard Dark / Standard Contrast and Pocket Cream / Night / Gaucho / Pistachio / Ink, contrast checks and fix, Day and Night slots, import from a file or a chatbot reply), `src/ui/kit.css` + `kit.js` (the Standard and Pocket looks) and `src/lib/icons.js`, ported from BetterWebWork with `as-` in place of `bw-`; keep them in step with the siblings. Colours come only from the `--as-*` tokens. Every built-in passes the contrast checks (tested). Pages build markup with `AS.mount`/`AS.frag` (DOMParser into a template), never `innerHTML`, which addons.mozilla.org's linter flags. The on-page card is built with `createElement` in a closed shadow root and takes the theme's tokens as variables.
- **Private repo, placeholder data.** Tests and fixtures use made-up addresses. Nothing local (paths, tokens, client secrets) in a commit. Commit as imanimal `116379547+imanimal@users.noreply.github.com`.

## Commands

```bash
node --test tests/core.test.js
```

```bash
python -m unittest discover -s tests -p "test_*.py"
```

```bash
python tools/build.py
```

Try it: Firefox `about:debugging` → Load Temporary Add-on → `manifest.json`; Chrome `chrome://extensions` → Developer mode → Load unpacked → this folder. Then `python host/install_host.py` for iCloud/IMAP. The sign-in flows need real accounts and a Google Cloud OAuth client, so they can't be tested offline; everything else has tests with a fake `fetch`, a fake IMAP server, or recorded response shapes.

## Layout

- `src/lib/`: `util.js` (AS.api, storage, helpers, PKCE, OAuth post), `codes.js` (extraction), `google.js`, `microsoft.js` (Graph; untested live), `imap.js` (native-messaging client and presets), `inbox.js` (background: poll, keep, badge, notify).
- `src/lib/themes.js` (themes, pure apart from `apply`/`look`), `src/lib/icons.js` (line icons for Standard, 9x9 pixel icons for Pocket). `src/ui/`: `kit.css`, `kit.js` (keys, stats, previews, toasts), `look.js` (the Look section: slots, theme grid, color editor, import). `fonts/`: SIL OFL woff2 files and their licenses.
- `src/background.js`: message router, alarm, commands, fill-into-tab, content-script registration. `src/content/`: `fill.js` (find and fill code boxes, injectable alone), `offer.js` (the card, fast polling). `src/pages/`: popup, options and `page.css`.
- `host/`: the IMAP helper and its installer. `tools/`: `build.py`, `gen_icons.py`. `tests/`: Node and Python tests.
