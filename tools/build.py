"""Package PocketCodes (stdlib only).

    python tools/build.py              dist/pocketcodes-<version>-firefox.zip and -chrome.zip, the unsigned extension
                                       (load the Firefox one in about:debugging, or sign it on addons.mozilla.org)
    python tools/build.py --updates    also dist/updates.json, the update manifest Firefox polls
                                       (manifest.json's update_url points at the latest release's copy)
    python tools/build.py --bump 0.2.0 set the version in manifest.json first

The Firefox package drops the manifest's `key` (Chrome's ID pin, which addons.mozilla.org's linter rejects) and
the `service_worker` line Firefox doesn't run. The Chrome package drops `background.scripts` and
`browser_specific_settings`. The IMAP helper (host/) isn't packaged: it's installed from this folder.
With GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET set, the Firefox package's src/lib/client.js carries the built-in
Google client (see that file); without them it stays blank and Gmail uses the client entered in Settings.

Releases are built by .github/workflows/release.yml, which has Mozilla sign the Firefox package as an unlisted
add-on and attaches the .xpi, updates.json and the Chrome zip to the GitHub release."""
import argparse
import json
import os
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = "imanimal/pocketcodes"
INCLUDE = ["LICENSE", "src", "icons", "fonts"]


def manifest():
    with open(os.path.join(ROOT, "manifest.json"), encoding="utf-8") as f:
        return json.load(f)


def bump(version):
    path = os.path.join(ROOT, "manifest.json")
    with open(path, encoding="utf-8") as f:
        text = f.read()
    old = json.loads(text)["version"]
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text.replace(f'"version": "{old}"', f'"version": "{version}"', 1))
    print(f"version {old} -> {version}")


def for_browser(m, browser):
    m = json.loads(json.dumps(m))
    if browser == "firefox":
        m.pop("key", None)
        m["background"].pop("service_worker", None)
    else:
        m.pop("browser_specific_settings", None)
        m["background"].pop("scripts", None)
    return m


CLIENT = "src/lib/client.js"


def client_js():
    """client.js with the built-in Google client from GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET, or None if unset."""
    cid, secret = os.environ.get("GOOGLE_CLIENT_ID", "").strip(), os.environ.get("GOOGLE_CLIENT_SECRET", "").strip()
    if not cid or not secret:
        return None
    with open(os.path.join(ROOT, CLIENT), encoding="utf-8") as f:
        text = f.read()
    blank = 'PC.CLIENT = { google: { id: "", secret: "" } };'
    if blank not in text:
        raise SystemExit(f"{CLIENT} no longer has the line build.py fills in")
    return text.replace(blank, f"PC.CLIENT = {{ google: {{ id: {json.dumps(cid)}, secret: {json.dumps(secret)} }} }};")


def package(dist, browser):
    m = for_browser(manifest(), browser)
    out = os.path.join(dist, f"pocketcodes-{m['version']}-{browser}.zip")
    # only Firefox can use the built-in client (its loopback redirect); Chrome keeps the blank one
    client = client_js() if browser == "firefox" else None
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", json.dumps(m, indent=2, ensure_ascii=False) + "\n")
        for item in INCLUDE:
            full = os.path.join(ROOT, item)
            if os.path.isfile(full):
                z.write(full, item)
                continue
            for base, _, files in os.walk(full):
                for name in sorted(files):
                    p = os.path.join(base, name)
                    rel = os.path.relpath(p, ROOT).replace(os.sep, "/")
                    if rel == CLIENT and client:
                        z.writestr(rel, client)
                    else:
                        z.write(p, rel)
    print(out)
    return out


def updates(dist):
    m = manifest()
    gecko = m["browser_specific_settings"]["gecko"]
    v = m["version"]
    doc = {"addons": {gecko["id"]: {"updates": [{
        "version": v,
        "update_link": f"https://github.com/{REPO}/releases/download/v{v}/pocketcodes-{v}.xpi",
        "applications": {"gecko": {"strict_min_version": gecko.get("strict_min_version", "128.0")}},
    }]}}}
    out = os.path.join(dist, "updates.json")
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        json.dump(doc, f, indent=2)
    print(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--updates", action="store_true")
    ap.add_argument("--bump")
    a = ap.parse_args()
    if a.bump:
        bump(a.bump)
    dist = os.path.join(ROOT, "dist")
    os.makedirs(dist, exist_ok=True)
    for browser in ("firefox", "chrome"):
        package(dist, browser)
    if a.updates:
        updates(dist)


if __name__ == "__main__":
    main()
