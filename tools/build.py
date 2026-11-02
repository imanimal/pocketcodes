#!/usr/bin/env python3
"""Packages AuthSkip for each browser: dist/authskip-<version>-firefox.zip and -chrome.zip.

    python tools/build.py           both zips
    python tools/build.py --store   the same, with Chrome's "key" left out too (the Chrome Web Store sets the ID)

The source tree loads unpacked in both browsers as it is; the zips only trim what each one doesn't use:
  Firefox: no "key" (Firefox ignores it, and addons.mozilla.org's linter warns) and no background.service_worker,
           since Firefox runs background.scripts.
  Chrome:  no browser_specific_settings and no background.scripts, since Chrome runs the service worker.
The zips are reproducible: sorted entries, fixed timestamps.
"""

import argparse
import copy
import json
import os
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INCLUDE = ["LICENSE", "README.md", "PRIVACY.md", "src", "icons", "host"]
SKIP_DIRS = {"__pycache__", ".git", "node_modules"}
SKIP_EXT = {".pyc", ".pyo"}
STAMP = (2026, 1, 1, 0, 0, 0)


def manifest_for(base, browser, store=False):
    m = copy.deepcopy(base)
    bg = m.get("background", {})
    if browser == "firefox":
        m.pop("key", None)
        bg.pop("service_worker", None)
    else:
        m.pop("browser_specific_settings", None)
        bg.pop("scripts", None)
        if store:
            m.pop("key", None)
    return m


def files():
    out = []
    for item in INCLUDE:
        path = os.path.join(ROOT, item)
        if os.path.isfile(path):
            out.append(item)
        elif os.path.isdir(path):
            for d, dirs, names in os.walk(path):
                dirs[:] = sorted(x for x in dirs if x not in SKIP_DIRS)
                for n in names:
                    if os.path.splitext(n)[1] not in SKIP_EXT:
                        out.append(os.path.relpath(os.path.join(d, n), ROOT).replace(os.sep, "/"))
    return sorted(out)


def check(base, names):
    """Everything the manifest names has to be in the zip."""
    want = list(base["background"]["scripts"]) + [base["background"]["service_worker"], base["action"]["default_popup"], base["options_ui"]["page"]]
    want += list(base["icons"].values()) + list(base["action"]["default_icon"].values())
    missing = sorted(set(w for w in want if w not in names))
    if missing:
        raise SystemExit("Missing from the package: " + ", ".join(missing) + (" (run tools/gen_icons.py)" if any(w.startswith("icons/") for w in missing) else ""))


def write_zip(path, manifest, names):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        info = zipfile.ZipInfo("manifest.json", STAMP)
        info.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(info, json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
        for n in names:
            info = zipfile.ZipInfo(n, STAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o755 if n.endswith(".py") else 0o644) << 16
            with open(os.path.join(ROOT, n), "rb") as f:
                z.writestr(info, f.read())


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--store", action="store_true", help="leave Chrome's key out (for a Chrome Web Store upload)")
    a = p.parse_args(argv)
    with open(os.path.join(ROOT, "manifest.json"), encoding="utf-8") as f:
        base = json.load(f)
    names = files()
    check(base, names)
    dist = os.path.join(ROOT, "dist")
    os.makedirs(dist, exist_ok=True)
    for browser in ("firefox", "chrome"):
        out = os.path.join(dist, "authskip-%s-%s.zip" % (base["version"], browser))
        write_zip(out, manifest_for(base, browser, a.store), names)
        print("%s  (%d files, %d KB)" % (os.path.relpath(out, ROOT), len(names) + 1, (os.path.getsize(out) + 1023) // 1024))


if __name__ == "__main__":
    main()
