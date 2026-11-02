#!/usr/bin/env python3
"""Installs the PocketCodes IMAP helper for Firefox and the Chrome family (Chrome, Edge, Brave, Chromium).

    python host/install_host.py               install, or update after pulling a new version
    python host/install_host.py --uninstall   take it out of every browser (your accounts' passwords stay)
    python host/install_host.py --purge       take it out and delete its accounts and passwords too
    python host/install_host.py --chrome-id ID   also allow a Chrome extension ID other than the pinned one

It copies pocketcodes_host.py into PocketCodes' data folder (so moving or deleting this folder doesn't break it),
writes a small launcher that runs it with this Python, and tells each browser where it is: a registry key under
HKEY_CURRENT_USER on Windows, a manifest file in each browser's NativeMessagingHosts folder on macOS and Linux.
Nothing needs administrator rights. Restart the browser afterwards.
"""

import argparse
import base64
import hashlib
import json
import os
import shlex
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import pocketcodes_host as host  # noqa: E402

NAME = "io.github.imanimal.pocketcodes"
DESCRIPTION = "PocketCodes IMAP helper"
FIREFOX_ID = "codes@imanimal.github.io"
MANIFEST = os.path.join(os.path.dirname(HERE), "manifest.json")


# ── pure parts (tested) ──

def chrome_id_from_key(key_b64):
    """Chrome's extension ID for a manifest "key": the first 128 bits of SHA-256 of the DER public key, as
    hex digits written with the letters a to p."""
    digest = hashlib.sha256(base64.b64decode(key_b64)).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in digest)


def chrome_manifest(path, ids):
    return {
        "name": NAME, "description": DESCRIPTION, "path": path, "type": "stdio",
        "allowed_origins": ["chrome-extension://%s/" % i for i in ids],
    }


def firefox_manifest(path):
    return {"name": NAME, "description": DESCRIPTION, "path": path, "type": "stdio", "allowed_extensions": [FIREFOX_ID]}


# (browser, family, Windows registry key under HKCU, macOS folder under ~/Library/Application Support, Linux folder under ~)
BROWSERS = [
    ("Chrome", "chrome", r"Software\Google\Chrome", "Google/Chrome", ".config/google-chrome"),
    ("Edge", "chrome", r"Software\Microsoft\Edge", "Microsoft Edge", ".config/microsoft-edge"),
    ("Brave", "chrome", r"Software\BraveSoftware\Brave-Browser", "BraveSoftware/Brave-Browser", ".config/BraveSoftware/Brave-Browser"),
    ("Chromium", "chrome", r"Software\Chromium", "Chromium", ".config/chromium"),
    ("Firefox", "firefox", r"Software\Mozilla", "Mozilla", ".mozilla"),
]


def targets(os_name, home):
    """Where each browser looks for the helper: [(browser, family, where, base)]. On Windows `where` is a
    registry key and `base` the browser's own key; elsewhere `where` is the manifest file to write and `base`
    the browser's profile folder, which tells us whether that browser is installed."""
    out = []
    for browser, family, reg, mac, linux in BROWSERS:
        if os_name == "windows":
            out.append((browser, family, reg + "\\NativeMessagingHosts\\" + NAME, reg))
            continue
        if os_name == "macos":
            base = os.path.join(home, "Library", "Application Support", *mac.split("/"))
            folder = os.path.join(base, "NativeMessagingHosts")
        else:
            base = os.path.join(home, *linux.split("/"))
            folder = os.path.join(base, "native-messaging-hosts" if family == "firefox" else "NativeMessagingHosts")
        out.append((browser, family, os.path.join(folder, NAME + ".json"), base))
    return out


def launcher_text(os_name, python, script):
    if os_name == "windows":
        return '@echo off\r\n"%s" -I -B "%s" %%*\r\n' % (python, script)
    return '#!/bin/sh\nexec %s -I -B %s "$@"\n' % (shlex.quote(python), shlex.quote(script))


def pinned_chrome_id(manifest_path=MANIFEST):
    with open(manifest_path, "r", encoding="utf-8") as f:
        return chrome_id_from_key(json.load(f)["key"])


# ── the install itself ──

def install_dir():
    return os.path.join(host.data_dir(), "host")


def _write(path, text, mode=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    if mode is not None:
        os.chmod(path, mode)


def _reg_set(key, value):
    import winreg
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key) as k:
        winreg.SetValueEx(k, "", 0, winreg.REG_SZ, value)


def _reg_delete(key):
    import winreg
    try:
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key)
        return True
    except FileNotFoundError:
        return False


def _reg_exists(key):
    import winreg
    try:
        winreg.CloseKey(winreg.OpenKey(winreg.HKEY_CURRENT_USER, key))
        return True
    except FileNotFoundError:
        return False


def install(extra_ids):
    osn = host.os_name()
    if osn == "windows" and "WindowsApps" in sys.executable:
        sys.exit("This is the Microsoft Store build of Python, which can't register a helper the browser can start.\n"
                 "Install Python from python.org (tick \"Add python.exe to PATH\"), then run this again with it.")
    if sys.version_info < (3, 8):
        sys.exit("The helper needs Python 3.8 or newer; this is %s." % sys.version.split()[0])

    ids = [pinned_chrome_id()] + [i for i in extra_ids if i]
    d = install_dir()
    os.makedirs(d, exist_ok=True)
    script = os.path.join(d, "pocketcodes_host.py")
    shutil.copyfile(os.path.join(HERE, "pocketcodes_host.py"), script)
    run = os.path.join(d, "pocketcodes_host.bat" if osn == "windows" else "pocketcodes_host.sh")
    _write(run, launcher_text(osn, sys.executable, script), None if osn == "windows" else 0o755)

    manifests = {"chrome": chrome_manifest(run, ids), "firefox": firefox_manifest(run)}
    done = []
    if osn == "windows":
        for family, m in manifests.items():
            _write(os.path.join(d, "%s.%s.json" % (NAME, family)), json.dumps(m, indent=2) + "\n")
        for browser, family, key, base in targets(osn, os.path.expanduser("~")):
            if browser in ("Chrome", "Firefox") or _reg_exists(base):
                _reg_set(key, os.path.join(d, "%s.%s.json" % (NAME, family)))
                done.append(browser)
    else:
        for browser, family, path, base in targets(osn, os.path.expanduser("~")):
            if browser in ("Chrome", "Firefox") or os.path.isdir(base):
                _write(path, json.dumps(manifests[family], indent=2) + "\n", 0o644)
                done.append(browser)

    print("PocketCodes helper %s installed for %s." % (host.VERSION, ", ".join(done)))
    print("  helper:  %s" % script)
    print("  python:  %s" % sys.executable)
    print("  Chrome extension ID allowed: %s" % ", ".join(ids))
    print("Restart the browser, then use Settings -> IMAP helper -> Check the helper.")


def uninstall(purge):
    osn = host.os_name()
    gone = []
    for browser, family, where, base in targets(osn, os.path.expanduser("~")):
        if osn == "windows":
            if _reg_delete(where):
                gone.append(browser)
        elif os.path.exists(where):
            os.remove(where)
            gone.append(browser)
    shutil.rmtree(install_dir(), ignore_errors=True)
    print("Took the helper out of %s." % (", ".join(gone) or "no browser (it wasn't installed)"))
    if purge:
        accts = host.load_accounts()
        v = host.vault()
        for acct in accts:
            try:
                v.delete(acct)
            except Exception as e:
                print("  couldn't delete the saved password for %s: %s" % (acct, e))
        shutil.rmtree(host.data_dir(), ignore_errors=True)
        print("Deleted %d saved IMAP login(s) and %s." % (len(accts), host.data_dir()))
    else:
        print("Saved IMAP logins stay in %s and the OS vault; --purge deletes them." % host.data_dir())


def main(argv=None):
    p = argparse.ArgumentParser(description="Install the PocketCodes IMAP helper for Firefox and Chrome-family browsers.")
    p.add_argument("--uninstall", action="store_true", help="take the helper out of every browser")
    p.add_argument("--purge", action="store_true", help="also delete the helper's accounts and saved passwords")
    p.add_argument("--chrome-id", action="append", default=[], metavar="ID", help="also allow this Chrome extension ID (repeatable)")
    a = p.parse_args(argv)
    if a.uninstall or a.purge:
        uninstall(a.purge)
    else:
        install(a.chrome_id)


if __name__ == "__main__":
    main()
