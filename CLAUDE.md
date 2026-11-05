# PocketCodes: notes for Claude

A Firefox and Chrome MV3 extension (one source tree, one manifest) that collects one-time codes from any number of Gmail, Outlook and IMAP (iCloud, Yahoo, Fastmail, custom) inboxes into one list, with one-click fill. Sibling of BetterWebWork and PocketCanvas (`../betterwebwork`, `../pocketcanvas`); same conventions. The user is a UCSB CS student on Windows 11 + Mac who has only Google and iCloud accounts.

## Invariants

- **Reads only.** Gmail scope is `gmail.readonly`, Graph scope `Mail.Read`, IMAP uses `EXAMINE` and `BODY.PEEK`. Nothing is ever sent, deleted, flagged or marked read. Message bodies are searched and dropped; only the code, sender name, subject and time are kept.
- **Unlimited accounts, no server.** Google and Microsoft sign in per account through `identity.launchWebAuthFlow` (authorization code + PKCE) against the built-in Google client (`src/lib/client.js`: a Desktop-app client, used through Firefox's loopback redirect `http://127.0.0.1/mozoauth2/<id>`; blank in the repo, filled into the Firefox package by `tools/build.py` from the `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` release secrets) or the user's own client entered in Settings (Chrome, or by choice). A token remembers its client (`via`), since a refresh token only works with the client that issued it. One refresh token per account in `tok:<id>`. `$0`: no paid services.
- **Single writer.** Only the background script (`inbox.js`) writes `accounts`, `tok:*`, `seen:*`, `st:*`, `codes`, `meta`; pages read storage and send messages (`background.js` `handlers`). The pages write only `settings`, `google`, `microsoft`. The key list is in `src/lib/util.js`'s header.
- **IMAP goes through the helper.** An extension can't open IMAP sockets, so `host/pocketcodes_host.py` (stdlib Python, native messaging, installed once by `host/install_host.py`) logs in, checks the password, and keeps it in the OS vault (Windows DPAPI via ctypes, macOS Keychain via `security`, Linux 0600 file). The extension never stores an IMAP password. The wire format is in `src/lib/imap.js`'s header: requests `{id, op, ...}`, answers `{re, ok|error, auth?, code?}`; ops `hello`, `add`, `remove`, `poll`.
- **Providers share one shape.** `{ signIn, fetchRecent(account, {since, skip}), revoke }`; `fetchRecent` returns `{key, from, subject, text, at}` for messages whose key isn't in `skip`. Keys: `g:<id>`, `m:<id>`, `i:<acct>:<uidvalidity>:<uid>`. New provider = new file with that shape plus a branch in `inbox.js`/options.
- **Pure parts are tested.** `src/lib/codes.js` (extraction) has no browser APIs; every rule has a case in `tests/core.test.js`, and the quiet cases (messages that must give nothing) too. Change a rule, add a case.
- **Buildless.** Classic scripts on `globalThis.PC`, no npm, no bundler. Keep in step: the manifest's background `scripts`, `background.js`'s `importScripts` (Chrome's service worker), the `<script>` tags in `src/pages/*.html` (and `tests/fixtures/preview.html`), and the manifest's `content_scripts` list (with the files `background.js` `fillTab` injects).
- **Two browsers, one tree.** `manifest.json` loads unpacked in Firefox 128+ and Chrome 111+ as it is (Firefox runs `background.scripts`, Chrome the `service_worker`). `tools/build.py` writes each browser's zip; it drops `key` from the Firefox one. The manifest `key` pins the Chrome extension ID (`kammpeiopjjhipmdggclkefddnlagnpk`) so the OAuth redirect URI and the helper's `allowed_origins` stay stable; Firefox's ID is `codes@imanimal.github.io`. Never type `\uXXXX` escapes into files through some tools: they get turned into raw characters. `codes.js` builds its invisible-character classes from `String.fromCharCode`.
- **Codes pop up by themselves.** The manifest asks for all-sites access at install and runs `util.js` + `fill.js` + `offer.js` on every page as `content_scripts`, so nobody has to open the toolbar button or turn anything on. As soon as a code box appears (and an inbox is added), the chip pops up waiting and fast-checks, then shows the code the moment it lands. `settings.page` is the off switch (step 2 of the settings page); if the browser's site access is taken away, step 2 and the popup offer Allow. Fill on the current tab (popup key, Alt+Shift+F) still works through `activeTab`. The content script only reads code boxes and the form around them, and sends nothing from the page anywhere.
- **Pocket look.** The icon's device, as in PocketCanvas and Collegiapp: cream plastic (Night: graphite with a teal LCD, chrome darker than the body), raised keys with a lip, orange for the main action, graphite label bands in Space Mono capitals, codes on an LCD inlay in Doto. Tokens on `:root` in `src/pages/page.css` are PocketCanvas's Pocket Cream and Night; fonts are bundled in `fonts/` (OFL, copied from `../betterwebwork/fonts`), never loaded from the network. Sentence case, no emoji. Pages build markup with `PC.mount`/`PC.frag` (DOMParser into a template), never `innerHTML`, which addons.mozilla.org's linter flags. The on-page chip is built with `createElement` in a closed shadow root.
- **Code boxes are found by fill.js alone.** It reads a box's attributes and labels, and for a bare numeric box the text of its form; it searches open shadow roots and fills with composed events. Only a visible tab shows or auto-fills a code. Every shape has a case in `tests/fixtures/pages.html` (finds and quiet cases); change a rule, add a section.
- **Public repo, placeholder data.** Public so Firefox can fetch `updates.json` and the `.xpi` from releases. Tests and fixtures use made-up addresses. Nothing local (paths, tokens, client secrets) in a commit. Commit as imanimal `116379547+imanimal@users.noreply.github.com`.

## Commands

```bash
node --test tests/core.test.js tests/google.test.js
```

```bash
python -m unittest discover -s tests -p "test_*.py"
```

```bash
python tools/build.py
```

```bash
node tools/e2e.mjs
```

`tools/e2e.mjs` installs this folder in a headless Firefox (throwaway profile, WebDriver BiDi), checks the chip is on from install, and checks the real content script on the fixture pages (waiting chip included), the Fill path and the helper; `SHOTS=<dir>` (with `SCHEME=light|dark`) also screenshots the chip, waiting and with a code. `tests/fixtures/run.html` (serve the repo root) runs the detection and chip cases in any browser; `tests/fixtures/preview.html?page=popup|options` shows the real pages with made-up data, since extension pages can't be screenshotted over BiDi.

Releases are tag-driven (`.github/workflows/release.yml`): `python tools/build.py --bump X.Y.Z`, commit, tag `vX.Y.Z`, push the tag; it builds with the built-in Google client (secrets `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`), signs the Firefox package unlisted on AMO (secrets `AMO_JWT_ISSUER`, `AMO_JWT_SECRET`) and publishes the `.xpi`, `updates.json` and the Chrome zip. Installed copies self-update through the manifest's `update_url`, which only works because the repo is public.

Try it: Firefox `about:debugging` → Load Temporary Add-on → `manifest.json`; Chrome `chrome://extensions` → Developer mode → Load unpacked → this folder. Then `python host/install_host.py` for iCloud/IMAP. The Google and Microsoft sign-ins need real accounts, so they can't be tested offline; everything else has tests with a fake `fetch`, a fake IMAP server, or recorded response shapes.

## Layout

- `src/lib/`: `util.js` (PC.api, storage, helpers, PKCE, OAuth post), `client.js` (the built-in Google client, blank here), `codes.js` (extraction), `google.js`, `microsoft.js` (Graph; untested live), `imap.js` (native-messaging client and presets), `inbox.js` (background: poll, keep, badge, notify).
- `src/background.js`: message router, alarm, commands, fill-into-tab, the 0.2.0 → 0.2.1 settings migration. `src/content/`: `fill.js` (find and fill code boxes, injectable alone), `offer.js` (the chip, fast polling). `src/pages/`: popup and options.
- `host/`: the IMAP helper and its installer. `tools/`: `build.py`, `gen_icons.py`, `e2e.mjs`. `tests/`: Node and Python tests; `tests/fixtures/`: code-box pages, their runner and the page preview. `fonts/`: Space Grotesk, Space Mono, Doto.
