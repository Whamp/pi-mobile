"""Debug AVD setup: reuse already-extracted assets only after byte comparison."""

import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import zipfile

old_apk, new_apk, destination = map(Path, sys.argv[1:4])
destination.mkdir(parents=True, exist_ok=True)
adb = str(Path.home() / "Android/Sdk/platform-tools/adb")
serial = os.environ.get("P2W_ADB_SERIAL", "emulator-5572")


def payload(path):
    with zipfile.ZipFile(path) as apk:
        version = apk.read("assets/app-version.txt")
        with zipfile.ZipFile(io.BytesIO(apk.read("assets/app.zip"))) as app:
            files = {
                item.filename: hashlib.sha256(app.read(item)).hexdigest()
                for item in app.infolist()
                if not item.is_dir()
            }
    return version, files


def command(*args):
    result = subprocess.run([adb, "-s", serial, *args], check=True,
                            capture_output=True, timeout=1200)
    return result.stdout


old_version, old_files = payload(old_apk)
new_version, new_files = payload(new_apk)
assert old_files == new_files, "App payload changed: perform a normal fresh extraction"
installed = command("shell", "run-as", "dev.whamp.p2w", "cat", "files/app/.installed-version")
assert installed.strip() == old_version.strip(), "Installed assets are not the expected baseline"
proof = {
    "serial": serial,
    "oldVersion": old_version.decode().strip(),
    "newVersion": new_version.decode().strip(),
    "files": len(new_files),
    "payloadDigest": hashlib.sha256(json.dumps(new_files, sort_keys=True).encode()).hexdigest(),
    "oldApkSha256": hashlib.sha256(old_apk.read_bytes()).hexdigest(),
    "newApkSha256": hashlib.sha256(new_apk.read_bytes()).hexdigest(),
    "setup": "Reused byte-identical JS assets after Java-only APK update; explicitly enabled debug fake preference",
}
(destination / "identical-assets.json").write_text(json.dumps(proof, indent=2))
command("shell", "am", "force-stop", "dev.whamp.p2w")
(destination / "install.txt").write_bytes(command("install", "--no-streaming", "-r", str(new_apk)))
version_file = destination / "next-version.txt"
version_file.write_bytes(new_version)
preference_file = destination / "debug-fake.xml"
preference_file.write_text('<?xml version="1.0" encoding="utf-8"?><map><boolean name="fake" value="true" /></map>')
command("push", str(version_file), "/data/local/tmp/p2w-next-version.txt")
command("push", str(preference_file), "/data/local/tmp/p2w-debug-fake.xml")
command("shell", "run-as", "dev.whamp.p2w", "cp", "/data/local/tmp/p2w-next-version.txt", "files/app/.installed-version")
command("shell", "run-as", "dev.whamp.p2w", "mkdir", "-p", "shared_prefs")
command("shell", "run-as", "dev.whamp.p2w", "cp", "/data/local/tmp/p2w-debug-fake.xml", "shared_prefs/p2w.xml")
print(json.dumps(proof))
