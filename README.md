# PocketCodes

One-time sign-in codes from every Gmail, Outlook, iCloud and IMAP inbox you add, in one list in your browser's toolbar, with one-click fill. For Firefox 128+ and Chrome 111+.

- Add as many accounts as you like. Each one is checked every minute (or 2 or 5), and a new code shows on the toolbar badge and as a notification.
- **Fill** puts the newest fresh code into the page you're on: the popup's Fill key, or <kbd>Alt+Shift+F</kbd>. <kbd>Alt+Shift+C</kbd> opens the list.
- **Codes pop up on sign-in pages**: when a page asks for a code, a small chip pops up by the box on its own, checks your inboxes every few seconds, and shows the code the moment the email lands, with a Fill key (or it fills the box for you). No clicking the toolbar button. Firefox asks once, at install, to let PocketCodes run on all sites; it only looks at code boxes and the form around them. Only the tab you're looking at shows or fills a code, and step 2 of the settings page turns it off.
- **It goes by how the code was sent.** A page that emailed the code gets your inboxes' codes. A page that texted your phone gets no chip unless your texts reach PocketCodes, and then only codes that came by text. A page that wants an authenticator app's code gets that site's authenticator code, if you added one, and never an email code.
- **Authenticator codes, free.** Paste a site's two-factor key (its "Can't scan the QR code?" link) in settings, and its code shows by the box and in the toolbar list. The key goes to the helper, which keeps it in the operating system's vault; the extension only ever sees codes.
- **Duo passcodes.** A computer can't read Duo Mobile on your phone, so PocketCodes joins your school's (or work's) Duo as a tablet of its own: add a device in Duo, paste the link of the QR code it shows, and Duo's passcode box gets the code. Duo doesn't officially support this, and your school decides whether you can add devices and use passcodes.
- **Texts, free.** On a Mac with an iPhone, turn on Text Message Forwarding and PocketCodes reads new texts from Messages through the helper (the browser needs Full Disk Access). Anywhere else, have the phone forward texts to an inbox you added (an iPhone Shortcut automation or an Android forwarding app) with the subject `PocketCodes text`.
- The Pocket look of the icon: cream plastic, orange keys, codes on an LCD. It goes graphite with a teal LCD when your system is in dark mode.

## Privacy

PocketCodes only reads mail: Gmail with `gmail.readonly`, Outlook with `Mail.Read`, IMAP with `EXAMINE` and `BODY.PEEK`, so nothing is ever sent, deleted, moved or marked read. Message bodies are searched for a code and dropped; only the code, the sender's name, the subject and the time are kept, for a day. There is no server: Google and Microsoft sign-ins go straight from your browser to Google or Microsoft, and IMAP passwords and authenticator keys stay in your operating system's vault (Windows DPAPI, macOS Keychain) through the helper below, never in the extension. Texts on a Mac are read from Messages' own database, opened read-only, and only their codes are kept. Adding Duo sends Duo one request, the same one Duo Mobile sends to activate, and nothing after that. Keeping an authenticator in the browser that holds your passwords trades some of two-factor's protection for convenience; leave out the accounts that matter most.

## Install

Firefox: open the `.xpi` attached to the [latest release](https://github.com/imanimal/pocketcodes/releases/latest) in Firefox (128 or newer). It updates itself from the releases. To try a local change instead: `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → this folder's `manifest.json` (it stays until Firefox restarts).

Chrome: `chrome://extensions` → Developer mode → **Load unpacked** → this folder.

### Gmail

In Firefox, **Add Gmail** is a Google sign-in and nothing else. Google says PocketCodes isn't verified (it's a free personal app, and verification for mail access costs money): choose **Continue**.

Chrome, or a copy loaded from this folder, has no built-in Google sign-in, so it needs a free OAuth client of your own (about five minutes; Settings › Advanced › Use your own Google client):

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

Then **Add iCloud** in settings, with an app-specific password from [account.apple.com](https://account.apple.com/account/manage) → Sign-In and Security → App-Specific Passwords. `python host/install_host.py --uninstall` removes the helper and the passwords it kept. Run the installer again after updating PocketCodes.

## Develop

Buildless: classic scripts, no npm.

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

`tools/e2e.mjs` runs the real extension in a headless Firefox and checks code boxes get the code. `tools/build.py` writes `dist/pocketcodes-<version>-firefox.zip` and `-chrome.zip`. `tools/gen_icons.py` redraws the icons.

Release: `python tools/build.py --bump 0.2.0`, commit, tag `v0.2.0`, push the tag. The workflow builds with the built-in Google client (repository secrets `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, a Desktop app client), signs the Firefox package as an unlisted add-on (`AMO_JWT_ISSUER` and `AMO_JWT_SECRET` from addons.mozilla.org) and publishes the `.xpi`, `updates.json` and the Chrome zip. Installed copies check `updates.json` once a day.
