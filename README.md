# PocketCodes

One-time sign-in codes from every Gmail, Outlook, iCloud and IMAP inbox you add, in one list in your browser's toolbar, with one-click fill. For Firefox 128+ and Chrome 111+.

- Add as many accounts as you like. Each one is checked every minute (or 2 or 5), and a new code shows on the toolbar badge and as a notification.
- **Fill** puts the newest fresh code into the page you're on: the popup's Fill key, or <kbd>Alt+Shift+F</kbd>. <kbd>Alt+Shift+C</kbd> opens the list.
- Optional: a small chip by code boxes on sign-in pages that offers the code (or fills it as soon as it arrives). This one asks for permission to run on all sites, so it's off until you turn it on.

## Privacy

PocketCodes only reads mail: Gmail with `gmail.readonly`, Outlook with `Mail.Read`, IMAP with `EXAMINE` and `BODY.PEEK`, so nothing is ever sent, deleted, moved or marked read. Message bodies are searched for a code and dropped; only the code, the sender's name, the subject and the time are kept, for a day. There is no server: Google and Microsoft sign-ins go to your own OAuth client, and IMAP passwords stay in your operating system's vault (Windows DPAPI, macOS Keychain) through the helper below, never in the extension.

## Install

Firefox: `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → this folder's `manifest.json` (or `dist/pocketcodes-<version>-firefox.zip`). A temporary add-on stays until Firefox restarts; a permanent install needs the package signed on addons.mozilla.org.

Chrome: `chrome://extensions` → Developer mode → **Load unpacked** → this folder.

### Gmail

Gmail needs a free OAuth client of your own (about five minutes):

1. In [Google Cloud](https://console.cloud.google.com/projectcreate), create a project and enable the [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com).
2. Under **Google Auth Platform**, set it up as **External**, add the scope `gmail.readonly`, and either publish the app (it stays "unverified", which is fine for you) or add each address as a test user. Test mode ends sign-ins after 7 days.
3. Under **Clients**, create a **Web application** client and add the redirect URI shown in PocketCodes' settings (Firefox and Chrome each have their own; add both if you use both).
4. Paste the client ID and secret into PocketCodes' settings, then **Add Gmail**.

School and work Google accounts may block third-party apps. If yours does, forward its mail to a Gmail address you can add.

### iCloud and other IMAP

An extension can't open an IMAP connection, so a small helper does it (one stdlib Python file, Python 3.8+). Install it once, then restart the browser:

```bash
python host/install_host.py
```

Then **Add iCloud or other IMAP** in settings, with an app-specific password (for iCloud, from appleid.apple.com → Sign-In and Security). `python host/install_host.py --uninstall` removes the helper and the passwords it kept. Run the installer again after updating PocketCodes.

## Develop

Buildless: classic scripts, no npm.

```bash
node --test tests/core.test.js
```

```bash
python -m unittest discover -s tests -p "test_*.py"
```

```bash
python tools/build.py
```

`tools/build.py` writes `dist/pocketcodes-<version>-firefox.zip` and `-chrome.zip`. `tools/gen_icons.py` redraws the icons.
