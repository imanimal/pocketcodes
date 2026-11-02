# AuthSkip

One-time sign-in codes from every inbox you add (any number of Gmail, Outlook and iCloud or other IMAP accounts), in one list in your toolbar, with one-click fill. It runs in Firefox and in Chrome, Edge and Brave from the same folder.

- **Reads only.** Gmail is read with the `gmail.readonly` scope and Outlook with `Mail.Read`. IMAP mailboxes are opened with `EXAMINE` and `BODY.PEEK`. Nothing is ever sent, deleted, moved or marked read.
- **Keeps only the code.** Each message is searched and dropped. AuthSkip stores the code, the sender's name, the subject and the time, and forgets them after a day.
- **No server and nothing to pay.** Each account signs in straight to Google or Microsoft through your browser, against an OAuth client in your own free Google Cloud (or Microsoft Entra) project. iCloud and IMAP passwords stay in your operating system's own vault.
- **Fill in one key.** The popup's Fill button or <kbd>Alt+Shift+F</kbd> puts the newest code into the page you're on. If you turn on "Offer codes on sign-in pages", a small card next to a code box offers it for you.
- **Your look.** A plain Standard look by default, with Standard Dark at night, or one of the Pocket themes (the handheld look shared with BetterWebWork, Collegiapp and PocketCanvas). Every theme can be adjusted color by color, and themes import from a file or a chatbot.

## Install

AuthSkip isn't in a store, so you load it from this folder.

**Firefox (128 or newer).** Go to `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on…** and pick `manifest.json`. Firefox removes a temporary add-on when it quits. To keep it, use Firefox Developer Edition or Nightly: set `xpinstall.signatures.required` to `false` in `about:config` and install `dist/authskip-<version>-firefox.zip` from `about:addons` (gear menu → Install Add-on From File).

**Chrome, Edge, Brave.** Go to `chrome://extensions` (`edge://extensions` in Edge), turn on **Developer mode**, choose **Load unpacked** and pick this folder. The manifest's `key` pins the extension ID to `kammpeiopjjhipmdggclkefddnlagnpk`, so the Google redirect URI and the IMAP helper keep working after a reload.

Settings opens by itself the first time. Add the accounts there.

## Gmail: your own Google OAuth client (about five minutes, free)

Google only lets an app read Gmail through an OAuth client, and a shared client would need Google's paid security review. So you make one of your own. It is only ever used by you.

1. In [Google Cloud](https://console.cloud.google.com/projectcreate), create a project (any name). Turn on the [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com) in it.
2. Open **Google Auth Platform** and choose **Get started**. Pick audience **External** and fill in the app name and your email.
3. Under **Data access**, add the scope `https://www.googleapis.com/auth/gmail.readonly`.
4. Under **Audience**, choose one:
   - **Publish the app.** It stays "unverified", which is fine for your own use. At sign-in Google shows "Google hasn't verified this app": choose **Advanced → Go to (your app)**. Sign-ins last until you remove them.
   - **Stay in testing** and add each Gmail address under **Test users**. Google ends test-mode sign-ins after 7 days, so you'd sign in again every week.
5. Under **Clients**, create a client of type **Web application**. Add the redirect URI that AuthSkip's Settings → Gmail shows (there's a Copy button). With the IDs this repo pins, that is:
   - Chrome, Edge, Brave: `https://kammpeiopjjhipmdggclkefddnlagnpk.chromiumapp.org/`
   - Firefox: `https://032bafb4d34bccf53bd00b0f41e127fa1e54f298.extensions.allizom.org/`

   Using both browsers? Add both URIs to the same client.
6. Copy the **Client ID** and **Client secret** into Settings → Gmail, then choose **Add Gmail** under Accounts. Repeat **Add Gmail** for every account.

Work and school accounts (such as a university's Google Workspace) may be blocked by their admin from apps like this. If sign-in says access is blocked, forward that account's mail to a Gmail address you can add.

## iCloud and other IMAP mail

A browser extension can't open an IMAP connection, so a small helper does it: `host/authskip_host.py`, one Python file that uses only the standard library. The browser starts it when AuthSkip needs it, and it answers no other extension.

1. Install Python 3.8 or newer. On Windows, use the python.org installer and tick **Add python.exe to PATH**. The Microsoft Store build can't register a helper; the installer tells you if that's what you have. Macs with the Xcode command-line tools already have `python3`.
2. In this folder, run:

   ```
   python host/install_host.py
   ```

   (On a Mac, `python3 host/install_host.py`.) It copies the helper into AuthSkip's data folder and registers it with Firefox, Chrome, Edge, Brave and Chromium, for whichever of them you have. No administrator rights are needed. Restart the browser.
3. Settings → iCloud and IMAP → **Check** should show the helper's version.
4. Make an app-specific password. For iCloud: [account.apple.com](https://account.apple.com) → **Sign-In and Security** → **App-Specific Passwords** → **+**. Name it "AuthSkip" and copy the `xxxx-xxxx-xxxx-xxxx` password. Your Apple Account password won't work for IMAP. Yahoo, AOL, Fastmail and Zoho have the same kind of password in their security settings.
5. Settings → Accounts → **Add iCloud or IMAP**: pick the provider, enter the address and the app-specific password, then **Add account**. The helper checks the login. For iCloud it tries the full address first, then the part before the @, since older Apple accounts sign in with that. If the login works, the helper keeps the password.

Where the password goes:

| | Kept in | Data folder |
|---|---|---|
| Windows | DPAPI, sealed to your Windows sign-in, in `vault.json` | `%APPDATA%\AuthSkip` |
| macOS | your login Keychain, item "AuthSkip" | `~/Library/Application Support/AuthSkip` |
| Linux | `vault.json`, readable only by you (0600); not encrypted | `~/.local/share/authskip` |

On Windows and macOS there is no plaintext fallback: if the vault can't be used, adding the account fails. The extension itself never stores the password. Errors (never passwords or mail) go to `helper.log` in the data folder.

To update the helper after pulling a new version, run the installer again. `python host/install_host.py --uninstall` takes it out of every browser and keeps your saved logins. `--purge` deletes those logins as well. `--chrome-id <id>` also allows another Chrome extension ID, if you load AuthSkip under a different one.

## Outlook, Hotmail, Microsoft 365

Register an app in [Microsoft Entra](https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade) with account type **Accounts in any organizational directory and personal Microsoft accounts**. Add a **Mobile and desktop applications** platform with the redirect URI from Settings, and under **Authentication** allow public client flows. Then paste the application (client) ID into Settings → Outlook and choose **Add Outlook**.

This part is written to Microsoft's documentation and tested only against recorded response shapes. It hasn't been tried with a real Microsoft account.

## Using it

- The toolbar badge counts fresh codes you haven't seen. A notification shows each new code (you can turn that off).
- In the popup, each code has **Copy** and **Fill**. Fill types it into the page you're on.
- <kbd>Alt+Shift+C</kbd> opens the popup and <kbd>Alt+Shift+F</kbd> fills the newest fresh code. Change them on `about:addons` → gear → Manage Extension Shortcuts, or `chrome://extensions/shortcuts`.
- Every account is checked every minute (2 or 5 in Settings), and every few seconds while a sign-in page with a code box is open and the card is on. Each check reads the last half hour of mail.

## Looks and themes

Settings → Look. **Standard** is the default: flat, plain and quiet, with your system's font (or Atkinson Hyperlegible, which tells 0 from O and 1 from l). **Standard Dark** takes over at night, following your system; night can also follow a schedule, or stay on or off. **Standard Contrast** is black on white with strong borders.

The **Pocket** themes (Pocket Cream, Night, Gaucho, Pistachio and Ink) are the handheld look from Collegiapp. Each code shows on a small LCD in Doto digits, keys are raised, and headers are graphite bands. The popup, the settings page and the card on sign-in pages all wear the theme you pick, day or night.

Any theme can be adjusted color by color, with contrast checks and a "Fix contrast" button. Themes use the shared Pocket theme format, so one made for BetterWebWork, Collegiapp or PocketCanvas imports here as it is:

```json
{
  "pocketTheme": 1,
  "name": "Harbor",
  "look": "standard",
  "scheme": "dark",
  "tokens": {
    "bg": "#0f1b24", "surface": "#16252f", "line": "#2a3d48",
    "text": "#e6eef2", "text2": "#9fb3bf", "accent": "#4fb3a9", "on-accent": "#06201d"
  }
}
```

`look` is `standard` or `pocket`. There are 27 tokens; any you leave out come from the built-in theme of the same look and scheme, and the import says which. Pasting a chatbot's whole reply works: the JSON is found inside it. **Make one with a chatbot** opens Claude with the instructions filled in. Themes can't load images or fonts from anywhere.

## Limits

- The browser has to be open. Codes that arrive while it's closed show up on the next check, as long as they're less than half an hour old.
- Google test-mode sign-ins end after 7 days (see step 4 above). Admins can block work and school Google accounts.
- Outlook and the Windows and macOS password vaults haven't been tried for real yet. The Linux vault, the IMAP protocol handling (against a fake server) and everything else have automated tests.
- Code finding is heuristic. It wants a code word ("code", "OTP", "passcode", "PIN"…) near a 4 to 8 character code, and it ignores order numbers, prices, phone numbers and promo codes. If it misses a real code or picks a wrong one, open an issue with the subject and the sentence the code was in. Change the digits, keep the wording.

## Development

No build step, no npm: the scripts are classic files on `globalThis.AS`. See `CLAUDE.md` for the invariants and layout.

```
node --test tests/core.test.js                      # code finding, providers, inbox
python -m unittest discover -s tests -p "test_*.py"  # the IMAP helper and installer
python tools/build.py                                # dist/ zips for Firefox and Chrome
python tools/gen_icons.py                            # redraw icons/
```

## Credits

The theme format, the Standard and Pocket kit and the pixel icons are shared with BetterWebWork, Collegiapp and PocketCanvas. Fonts, all under the SIL Open Font License (texts in `fonts/`): Atkinson Hyperlegible Next and Mono (Braille Institute), Space Grotesk (Florian Karsten), Space Mono (Colophon Foundry) and Doto (Oliver Lalan).

## License

MIT. See [LICENSE](LICENSE) and [PRIVACY.md](PRIVACY.md).
