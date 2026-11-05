"""Package PocketCodes (stdlib only).

    python tools/build.py              dist/pocketcodes-<version>-firefox.zip and -chrome.zip, the unsigned extension
                                       (load the Firefox one in about:debugging, or sign it on addons.mozilla.org)
    python tools/build.py --bump 0.2.0 set the version in manifest.json first

The Firefox package drops the manifest's `key` (Chrome's ID pin, which addons.mozilla.org's linter rejects) and
the `service_worker` line Firefox doesn't run. The Chrome package drops `background.scripts` and
`browser_specific_settings`. The IMAP helper (host/) isn't packaged: it's installed from this folder."""
import argparse
import json
import os
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INCLUDE = ["LICENSE", "src", "icons"]


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


def package(dist, browser):
    m = for_browser(manifest(), browser)
    out = os.path.join(dist, f"pocketcodes-{m['version']}-{browser}.zip")
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
                    z.write(p, os.path.relpath(p, ROOT).replace(os.sep, "/"))
    print(out)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bump")
    a = ap.parse_args()
    if a.bump:
        bump(a.bump)
    dist = os.path.join(ROOT, "dist")
    os.makedirs(dist, exist_ok=True)
    for browser in ("firefox", "chrome"):
        package(dist, browser)


if __name__ == "__main__":
    main()
