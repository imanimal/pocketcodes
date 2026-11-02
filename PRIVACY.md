# PocketCodes privacy policy

Last updated November 2, 2026.

PocketCodes is a browser extension that finds one-time sign-in codes in the mailboxes you add and shows them in your browser. It has no server. Nothing it reads goes to the author or to anyone else.

## What it reads

- **Gmail**, through Google's Gmail API with the read-only scope `gmail.readonly`. It reads messages that arrived in your inbox in the last half hour.
- **Outlook, Hotmail and Microsoft 365**, through Microsoft Graph with the read-only scope `Mail.Read`. Same half hour.
- **iCloud and other IMAP mailboxes**, through the helper program in `host/` on your own computer. It opens the inbox read-only (`EXAMINE`) and reads the first 30 KB of recent messages with `BODY.PEEK`, so nothing is marked read.

PocketCodes never sends, deletes, moves, flags or marks mail as read, and it asks for no permission that would let it.

## What it keeps, and where

Everything stays on your computer, in the extension's own storage (`storage.local`) and, for IMAP, in the helper's data folder:

- **The codes it finds**: the code, the sender's display name, the subject, the time and which account it came from. Each one is deleted after 24 hours, and at most 40 are kept.
- **Your accounts**: the address and, for IMAP, the server, port and login name.
- **Sign-in tokens** for Google and Microsoft accounts: a refresh token and a short-lived access token per account.
- **Message IDs** already read (up to 300 per account), so the same message isn't read twice. These hold no message content.
- **Your settings**, and the OAuth client ID and secret you entered.
- **IMAP passwords** never go in the extension's storage. The helper keeps them in your operating system's vault: Windows DPAPI, the macOS Keychain, or on Linux a file only your user account can read.

Message bodies are searched for a code in memory and then dropped. They are never stored or logged. The helper's log (`helper.log` in its data folder) records only errors, such as "couldn't reach the server". It never records passwords or message content.

## Who it talks to

- `accounts.google.com`, `oauth2.googleapis.com` and `gmail.googleapis.com`, to sign in to and read your Gmail accounts.
- `login.microsoftonline.com` and `graph.microsoft.com`, to sign in to and read your Microsoft accounts.
- The IMAP servers you add (such as `imap.mail.me.com`), over TLS, from the helper on your computer.

Nothing else. There are no analytics, no crash reports, no ads and no remote code.

The Google and Microsoft sign-ins use an OAuth client that you create in your own Google Cloud or Microsoft Entra project. Google or Microsoft may show you as that project's owner how many sign-ins it has, as they do for any app. Their own privacy policies cover what they do with that.

## Web pages

If you turn on "Offer codes on sign-in pages", the extension asks for permission to run on all sites. On each page it looks only at form fields that look like code boxes (their type, name, label and size). When you press Fill, or choose to fill automatically, it types the code into them. It doesn't read the rest of the page and sends nothing from it anywhere. Without that permission, Fill works only on the tab you're on, when you press it.

## Removing it

- Removing an account in Settings deletes its tokens, its read-message IDs and its codes. Google is told the sign-in is no longer needed (Microsoft has no such call for this kind of app: end it at the link below), and the helper deletes an IMAP password from the vault.
- Removing the extension deletes everything in its storage.
- `python host/install_host.py --purge` removes the helper with its accounts and saved passwords.
- You can also end a Google sign-in at [myaccount.google.com/permissions](https://myaccount.google.com/permissions), a Microsoft one at [account.live.com/consent/Manage](https://account.live.com/consent/Manage), and an iCloud app-specific password at [account.apple.com](https://account.apple.com).

## Contact

Questions go to the issue tracker at https://github.com/imanimal/pocketcodes.
