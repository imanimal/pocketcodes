"""Install the PocketCodes IMAP helper for Firefox and Chrome (stdlib only). Run it once from the PocketCodes folder,
then restart the browser:

    python host/install_host.py               copy the helper into this user's data folder and register it
    python host/install_host.py --uninstall   unregister it, delete it and forget the passwords it kept

The helper is copied (not linked), so moving or deleting this folder doesn't break it; run this again after
updating PocketCodes. Registration is per user: HKCU keys on Windows, manifest files in the browsers' own
NativeMessagingHosts folders on macOS and Linux. Only the PocketCodes extension IDs may start it."""
import argparse
import json
import os
import shutil
import stat
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import pocketcodes_host as host  # noqa: E402

FIREFOX_ID = "codes@imanimal.github.io"
CHROME_ORIGIN = "chrome-extension://kammpeiopjjhipmdggclkefddnlagnpk/"
WIN_KEYS = {
    "firefox": r"Software\Mozilla\NativeMessagingHosts",
    "chrome": r"Software\Google\Chrome\NativeMessagingHosts",
    "edge": r"Software\Microsoft\Edge\NativeMessagingHosts",
}
HOME = os.path.expanduser("~")
UNIX_DIRS = {
    "Darwin": {
        "firefox": [f"{HOME}/Library/Application Support/Mozilla/NativeMessagingHosts"],
        "chrome": [f"{HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts",
                   f"{HOME}/Library/Application Support/Chromium/NativeMessagingHosts",
                   f"{HOME}/Library/Application Support/Microsoft Edge/NativeMessagingHosts"],
    },
    "Linux": {
        "firefox": [f"{HOME}/.mozilla/native-messaging-hosts"],
        "chrome": [f"{HOME}/.config/google-chrome/NativeMessagingHosts", f"{HOME}/.config/chromium/NativeMessagingHosts",
                   f"{HOME}/.config/microsoft-edge/NativeMessagingHosts"],
    },
}


def manifest(kind, launcher):
    m = {"name": host.NAME, "description": "PocketCodes IMAP helper", "path": launcher, "type": "stdio"}
    if kind == "firefox":
        m["allowed_extensions"] = [FIREFOX_ID]
    else:
        m["allowed_origins"] = [CHROME_ORIGIN]
    return m


def write(path, text, mode=None):
    with open(path, "w", encoding="utf-8", newline="\r\n" if path.endswith(".bat") else "\n") as f:
        f.write(text)
    if mode:
        os.chmod(path, mode)


def install():
    d = host.data_dir()
    os.makedirs(d, exist_ok=True)
    shutil.copyfile(os.path.join(HERE, "pocketcodes_host.py"), os.path.join(d, "pocketcodes_host.py"))
    py = sys.executable
    if host.SYSTEM == "Windows":
        launcher = os.path.join(d, "pocketcodes_host.bat")
        write(launcher, f'@echo off\n"{py}" -u "%~dp0pocketcodes_host.py" %*\n')
    else:
        launcher = os.path.join(d, "pocketcodes_host.sh")
        write(launcher, f'#!/bin/sh\nexec "{py}" -u "$(dirname "$0")/pocketcodes_host.py" "$@"\n', stat.S_IRWXU)
    manifests = {}
    for kind in ("firefox", "chrome"):
        p = os.path.join(d, f"{kind}.json")
        write(p, json.dumps(manifest(kind, launcher), indent=2) + "\n")
        manifests[kind] = p

    done = []
    if host.SYSTEM == "Windows":
        import winreg
        for browser, key in WIN_KEYS.items():
            with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key + "\\" + host.NAME) as k:
                winreg.SetValueEx(k, "", 0, winreg.REG_SZ, manifests["firefox" if browser == "firefox" else "chrome"])
            done.append(browser)
    else:
        for kind, dirs in UNIX_DIRS.get(host.SYSTEM, UNIX_DIRS["Linux"]).items():
            for folder in dirs:
                if kind != "firefox" and not os.path.isdir(os.path.dirname(folder)):
                    continue  # that browser isn't installed
                os.makedirs(folder, exist_ok=True)
                shutil.copyfile(manifests[kind], os.path.join(folder, host.NAME + ".json"))
                done.append(folder)
    print(f"Installed the helper in {d}")
    print("Registered for: " + ", ".join(done))
    print("Restart the browser, then press Check the helper in PocketCodes' settings.")


def uninstall():
    d = host.data_dir()
    vault = host.Vault()
    for acct in host._load("accounts.json"):
        vault.drop(acct)
    if host.SYSTEM == "Windows":
        import winreg
        for key in WIN_KEYS.values():
            try:
                winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key + "\\" + host.NAME)
            except OSError:
                pass
    else:
        for dirs in UNIX_DIRS.get(host.SYSTEM, UNIX_DIRS["Linux"]).values():
            for folder in dirs:
                try:
                    os.remove(os.path.join(folder, host.NAME + ".json"))
                except OSError:
                    pass
    shutil.rmtree(d, ignore_errors=True)
    print("Removed the helper, its registration and the passwords it kept.")


def main():
    ap = argparse.ArgumentParser(description="Install the PocketCodes IMAP helper.")
    ap.add_argument("--uninstall", action="store_true")
    a = ap.parse_args()
    uninstall() if a.uninstall else install()


if __name__ == "__main__":
    main()
