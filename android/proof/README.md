These helpers configure a dedicated proof AVD. Do not run them on a user's phone.
They do not create, reboot or restart an emulator and do not access KVM.

`wait-for-platform.sh` waits for Android settings, raises Android 15's system-server
watchdog timeout to ten minutes for slow TCG, and reduces bootstrap rendering to
480×800. This setting alone cannot prevent a watchdog decision already made
before the settings observer initializes. Record the actual platform logs.

After installing the APK, push and run `setup-device.sh` before launching p2w.
It disables the AVD lock screen and animations, grants notifications, requests
battery exemption and sets density 420 before WebView automation attaches.

`P2W_ADB_SERIAL=emulator-5572 node scripts/proof-emulator-ui.mjs` attaches Playwright
to the app's actual debug WebView, then captures onboarding, five models and the
foreground notification at folded and unfolded sizes. After enabling the debug
fake provider, `node scripts/proof-emulator.ts node-kill` or `force-stop` submits
one real ten-second torture script to the phone-local server, kills during step 3,
and checks the returned result against the log pulled with `run-as`. Run the UI
driver with the resulting session UUID to capture its interrupted step and final
result. `P2W_EMULATOR_PROOF` chooses the output directory for either driver.

If the AVD cannot make the Activity visible, the torture driver supports
`P2W_EMULATOR_MANUAL_SERVICE=1` for an explicitly recorded shell-assisted service
start after force-stop. This fallback does not prove normal Activity startup.
The node-kill method never manually restarts the service or Node.

These are proof drivers, not evidence that a native run passed. Consult the PR
and the emitted results/logs for actual outcomes and retained failures.

Use host port 18787 for the adb forward as well as device port 18787. The server
checks its actual listening port against Host/Origin; forwarding a different
host port correctly receives HTTP 403.

`reuse-identical-assets.py OLD_APK NEW_APK OUTPUT` is an optional debug AVD update
helper. It compares SHA-256 for every uncompressed app payload file and verifies
the installed baseline marker before doing anything. Only if the Java-only
update leaves every payload byte unchanged does it reuse extracted assets and
update their marker. It records both APK hashes and the payload digest, installs
the new APK, and explicitly sets the debug fake preference. This avoids repeating
the slow TCG extraction; it does not modify sessions or tool journals. A normal
fresh installation still extracts the packaged assets through RuntimeInstaller.
