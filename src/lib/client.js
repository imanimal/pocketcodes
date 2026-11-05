/* PocketCodes: the built-in Google client, so adding a Gmail account is one click and a Google sign-in, with nothing
   to set up. It's a "Desktop app" OAuth client in the PocketCodes Google Cloud project; Firefox signs in to it through
   its loopback redirect (http://127.0.0.1/mozoauth2/…), which Google accepts for Desktop clients without registering
   a redirect URI. Google treats a Desktop client's secret as not confidential (it ships inside every installed app),
   but it still stays out of this repo: this file is empty here, and tools/build.py fills it into the Firefox package
   from the GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET repository secrets when a release is built.
   Empty (a local copy loaded from this folder, or Chrome), Gmail falls back to your own client in Settings. */
(function (g) {
  const PC = (g.PC = g.PC || {});
  PC.CLIENT = { google: { id: "", secret: "" } };
})(globalThis);
