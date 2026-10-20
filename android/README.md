# Install p2w

Open `p2w-debug.apk` on the phone and allow **Install unknown apps** for the app
that opened it. This universal APK supports arm64-v8a and x86_64, requires Android
15 (API 35), and targets API 36. It is signed with a development certificate.
Keep the signing key if you want subsequent APKs to update this installation.
Uninstalling deletes the app's private sessions and provider credentials.

On first launch, open **Sign in to providers**. OpenAI Codex and Kimi use pi-ai's
browser OAuth flows; Z.AI accepts an API key. External links open the system
browser, whose localhost callback reaches the phone's Node process. Return to
p2w after completing the browser flow. Setup is skippable and available again at
**Providers → Phone setup and onboarding**. No host credentials are included.

Allow the notification and use the setup button to request battery exemption.
In Android's app settings, set p2w battery use to **Unrestricted**. For long runs,
disable child-process restrictions in Developer options where available. OEM
battery and phantom-process policies can still stop an agent. Force-stop stops
the foreground service and all app processes until you launch p2w again; reopening
resumes saved work. Removing the Activity from Recents leaves the service running.

The persistent notification and partial wake lock belong to a `specialUse`
foreground service. It owns and restarts Node. The Activity only hosts a WebView.
The server listens on `127.0.0.1:18787`; it is not bound to Wi-Fi. Workspaces live
under app-private `files/home`, session data under `files/mobile`, and temporary
tool files under writable `files/tmp`.

The tool named `bash` executes Android `/system/bin/sh` and system toybox utilities.
`sleep`, `echo`, `date`, `mkdir`, and `cat` are available. GNU bash syntax, GNU
coreutils, Git, npm, and arbitrary executable scripts installed into app storage
are not bundled. Node and its library dependencies execute from the APK's
installed native-library directory, respecting modern Android's writable-code
execution restriction. The current host still supports regular Termux separately.

## Build the APK

Use Node ≥22.19, JDK 21, Android SDK platform 36 and build-tools 36.0.0, Python 3,
curl, dpkg-deb, readelf, and unzip. Install dependencies without lifecycle scripts:

```sh
npm ci --ignore-scripts
python3 -m venv "$HOME/Android/host-tools"
"$HOME/Android/host-tools/bin/pip" install patchelf==0.17.2.4
scripts/build-apk.sh
JAVA_HOME="$HOME/Android/jdk" PATH="$HOME/Android/jdk/bin:$PATH" node scripts/inspect-apk.mjs
```

Override `JAVA_HOME`, `ANDROID_HOME`, or `PATCHELF` when installed elsewhere.
Gradle 8.13 is downloaded by the wrapper and checked against its SHA-256.
The output is `android/app/build/outputs/apk/debug/app-debug.apk`, also copied to
`/workspace/badlogic-torture/apk/p2w-debug.apk`. The inspector writes manifest,
signature, ABI inventory, and a recursive secret-pattern scan to `proof/apk`.
It also writes SHA-256/source-revision files and rejects an APK whose embedded
source marker does not match the current Git commit; rebuild after the last commit.
AWS's public SDK example access-key ID is recorded separately from secret matches.

`runtime-lock.json` pins every public Termux archive and SHA-256. The build only
extracts archives; it never runs package maintainer scripts. `prepare-runtime.mjs`
copies Node 24.18.0 and its nine private ELF dependencies for each ABI, rewrites
private dependency names and SONAMEs, and verifies at least 16 KiB LOAD alignment.
Public trust roots and upstream license notices are included. `package-android.mjs`
compiles the existing app layout, preserves portable production dependencies and
QuickJS WASM/worker files, omits dependency type declarations and source maps,
and substitutes static web hosting for development Vite. The compressed app ZIP
is stored directly in APK assets to avoid a second layer of inflation on launch.
Only explicit staging inputs enter app.zip; HOME, auth files and session data do
not. APK content is reproducible from pinned inputs; debug signing and ZIP/build
timestamps mean byte-identical APKs are not promised.

For a smaller software-emulator install, run `scripts/build-emulator-apk.sh`.
It builds the universal deliverable first, then creates the x86_64-only
`/workspace/badlogic-torture/apk/p2w-debug-x86_64-emulator.apk` without replacing
`p2w-debug.apk`. Both contain the same source revision and app payload. The
emulator artifact is unsuitable for Will's arm64 phone.
Inspect it separately with `node scripts/inspect-apk.mjs APK OUTPUT x86_64`;
omitting the final argument requires both universal ABIs.

## Debug proof mode

Real providers are the default. In the debug APK only, use **Providers → Debug
provider settings** to switch to the deterministic fake provider. Tools still
operate on the phone. Release builds ignore this switch and debug Intent extras.
For automated proof, a debug launch can use:

```sh
adb shell am start -n dev.whamp.p2w/.MainActivity --ez fake true
```

Send `torture <unique-alphanumeric-run-id>` in fake mode to run the SPEC's twelve
sequential 10-second shell calls inside durable codemode. No host script timeout
is supplied. Archive during call 3, restore, and open the same session. Call 3
reports `Tool bash was interrupted and may have partially run`; calls 4–12 and
the final cat continue without sending another message.

A worker-only SIGKILL can leave its independently grouped shell alive, so step 3
may append once after the worker dies. This is allowed by P1–P2, not exactly-once
external-effect semantics. Android force-stop kills the app's entire UID process
group, including those children. The host does not guess which orphan PID to kill
after restart, avoiding unsafe reaping on a shared machine.

Physical Pixel behavior, real provider sign-in, Android battery policy under a
long screen-off soak, and arm64 execution require device verification. Emulator
and web proof results are recorded separately in the PR and proof artifacts.

## Verification from the overnight build

The fake-provider host test passed the twelve-step codemode restart test three
times per requested kill method at the real ten-second sleep: archive/restore,
worker SIGKILL, whole-stack SIGKILL, server SIGTERM and owned process-group
SIGKILL. Each selected run interrupts step 3, catches the interruption, completes
steps 4–12 and final cat, and retains one submission without duplicate log lines.
The complete inventory, including failed attempts, is in
`/workspace/badlogic-torture/proof/torture/SUMMARY.md`.

Production web proof covers onboarding, the five models, interrupted step 3 and
the final result at folded and unfolded viewports. A video records an actual
archive/restore run. Files are under `/workspace/badlogic-torture/proof/web/`.

On the coordinator's software emulator, APK revision 1d59aed installed and ran
its own x86_64 Node v24.18.0 under the app UID. Normal Activity-owned foreground
promotion, its persistent notification state and localhost HTTP 200 were observed.
Cold Activity launch took 134,564 ms under TCG. First observed HTTP success was
64 minutes after launch, including platform stalls, renderer crashes and earlier
invalid health probes on a mismatched forwarded port; this is not a clean Node
startup benchmark. Host and device forwarding must both use port 18787.

Native twelve-step recovery, Node-kill restart and force-stop recovery were **not
verified**. Android repeatedly restarted system_server after watchdog stalls,
left user 0 in BOOTING and temporarily lost package/activity services. Updating
to the renderer-recovery APK failed during those platform restarts. Its byte-
identical JS payload comparison is evidence of matching assets, not a completed
update. The later service-only debug attempt never submitted a prompt. Native
screenrecord exited 235 and yielded an empty file; current platform frames were
black. The renderer-loss fix compiles but was not verified on-device. Native UI
proof at both sizes is therefore replaced by the explicitly labeled web proof.
See `/workspace/badlogic-torture/proof/emulator/RESULTS.md` for exact evidence.

A follow-up used a 50.7 MB x86_64-only APK, confirmed both Android install-verifier
settings were disabled, and attempted installation of a pushed file with `pm install -r -t`.
It also failed when the package service disappeared: Broken pipe (32), exit 224.
Earlier universal installs succeeded on 5570 (coordinator report) and 5572.
These failures show platform service loss under TCG load, not an APK validation
error. Reducing the APK size did not make the platform stable enough to test.
