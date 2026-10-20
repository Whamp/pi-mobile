# Android host design

The native Activity starts a foreground service, waits for localhost health, and
loads the existing web UI. Closing or folding the Activity never owns the agent
lifetime. The foreground service owns Node and retries its exit. Node retains the
existing single-worker-per-session ownership and Durable storage locks.

Candidate A and B both recommended a current target SDK with package-installed
Node and system sh/toybox. A patches private ELF dependency names; B proposed
versioned-library symlinks to preserve upstream bytes. An independent judge chose
A (22/25 versus 21/25). We choose deterministic ELF patching and graft B's preserved
production dependency tree, static UI security behavior, and persistent recovery.

The build downloads SHA-256-pinned Termux packages without executing maintainer
scripts. Node and its private shared-library closure live in extracted jniLibs,
with valid lib*.so filenames and 16 KiB ELF alignment. Java launches Node directly
from nativeLibraryDir. No writable application file needs executable permission.
Tools execute /system/bin/sh with PATH=/system/bin; the bash tool therefore offers
Android shell syntax rather than GNU bash. HOME and TMPDIR are app-writable.

Java boundaries:

- RuntimeInstaller.install(Context) returns app, home, workspace, tmp and native paths.
- RuntimeService owns foreground notification, partial wake lock, one supervisor
  thread and the Node process. It starts foreground before extracting assets.
- MainActivity owns WebView, readiness display, external HTTPS browser Intents,
  notification permission and battery settings. No general JavaScript bridge.

The APK packages compiled server/worker JS, portable production dependencies,
Codemode worker and QuickJS WASM, and a static Vite frontend. Development keeps
its current Vite HMR server. A packaging-time replacement chooses the static web
module so Android never loads Vite's host-native dependency. Existing owner/guest
gates, CSP nonce and session routes still apply to static assets.

Android startup restores persistent worker intent without resubmitting input.
Archive, user stop and idle eviction clear intent; shutdown and crash preserve it.
Force-stop pauses everything until the user launches the package again. A
specialUse foreground service avoids the dataSync time budget; it does not bypass
Android battery or phantom-process policy.

Acceptance sequence: installed Node version and SQLite/FTS, child fork IPC, shell
utilities, Codemode WASM, localhost WebView/provider callback fixture, then the
12-step restart test with call 3 observed before the kill. Check actual log counts,
result journal and conversation/submission identity, then capture both layouts.

Design experiments and scores are in .agent-artifacts/android-design-{a,b,judgment}.md.
