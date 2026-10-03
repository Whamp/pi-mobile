# Development guide

Read [AGENTS.md](AGENTS.md) first. Read this guide completely when resuming development, then [DESIGN.md](DESIGN.md) and [README.md](README.md). They distinguish implemented features from plans. Do not infer features from an earlier assistant's promises.

## Current state and pending work

Implemented: independent Durable session workers; catalog/search; shared settings/models/credentials; localhost provider login; React/Vite UI; per-session model/thinking selection; background subagents with inspectable conversations; on-demand conversation watches; uploads, syntax highlighting and copying; one-time owner tokens; external backend dev supervision.

Implemented also: session/subagent URLs and back/forward navigation; reusable session-scoped sharing with named guest identities, view/send/upload/Stop permissions, expiry/reset/revoke/mute/remove; server-assigned speaker attribution; writable subagent views. Owner sign-in is separate from guest sharing. Artifacts remain later.

## Environment

- Termux, Node 26 during development; package minimum Node 22.19. TypeScript runs through Node's strip-only mode; use erasable syntax.
- Source: `~/pi-mobile`; data: `~/.pi/mobile`, or `PI_MOBILE_DATA_DIR`. Keep runtime files and secrets outside the repository.
- `$TMPDIR` is writable; `/tmp` is not. Put ad-hoc scripts in `$TMPDIR`, use top-level imports and absolute package paths (bare imports do not resolve from `$TMPDIR`), and remove them afterwards.
- The optional reference checkout is `~/pi` (earendil-works/pi). Installed API declarations in `node_modules` are authoritative for the version we actually use. Pi coding-agent is not an application dependency.
- Direct dependencies are pinned. Install with `--ignore-scripts`; review lifecycle scripts. Refresh the lock with `npm install --package-lock-only --ignore-scripts`.

## Run and restart

Normal server:

```sh
npm start
```

Self-editing development server:

```sh
PI_MOBILE_ALLOWED_HOSTS=pim.ngrok.pro npm run dev
```

`npm run dev` runs `scripts/dev.mjs`, **outside** the server and all session workers.

- Vite handles `src/web/` and `index.html` changes without restarting the backend.
- The supervisor recursively watches `src/server/`, `src/shared/`, and `src/worker/`. Changes coalesce for 500 ms, then recycle the server and all its workers.
- It tracks running session IDs through Node IPC, freezes that set before shutdown, sends SIGTERM and waits for actual process completion before replacement. SIGKILL is a ten-second fallback, not the normal path.
- The replacement server reopens every previously running, non-archived session, including sessions with no browser viewer and background work. It does not submit new input. Durable recovers committed tasks from the same SQLite storage.
- Browser owner cookies survive server restart; clients reconnect and open from fresh snapshots. Never replay prompts automatically on reconnect.
- A normal `npm start` still starts no workers. A fresh supervisor starts none unless seeded; only code/crash restarts of that supervisor preserve its running set. If the supervisor itself is killed, its in-memory set is lost; saved Durable work remains available when sessions are opened.
- Changes to the supervisor itself, package/dependency configuration or startup environment require relaunching `npm run dev`.
- On backend syntax/startup errors the supervisor retries after two seconds; fix the source and inspect its log. It cannot serve the UI until the backend starts successfully.

Manual backend restart from a worker's bash tool:

```sh
kill -USR2 "$PI_MOBILE_DEV_SUPERVISOR_PID"
```

The supervisor PID is inherited by workers in dev mode. SIGUSR2 follows the same safe restart path as a code change. To stop development, send SIGTERM to the **supervisor**, not just its server child (otherwise the supervisor restarts the child).

When moving an already-running standalone server into dev mode, list its running sessions first and pass that JSON array as `PI_MOBILE_DEV_RESUME` when launching the supervisor. Stop the old server and wait for exit before starting the replacement. Never start competing owners of the same data directory.

Committed work survives orderly restart. An in-flight request may resume from its checkpoint; unsafe tools interrupted during execution are not blindly replayed. SQLite/WAL is not a promise of power-loss durability or exactly-once external effects. A killed credential-lock owner may require the 30-second stale-lock window.

## Backend map

Read these files **in full** before changing the relevant path:

- `src/shared/protocol.ts`: client/server actions and events; worker IPC.
- `src/server/app.ts`, `requests.ts`: authorization/action dispatch, validation, WebSocket handling.
- `src/server/catalog.ts`: SQLite metadata, search/index and subagent listing.
- `src/server/workers.ts`: per-session process ownership, readiness, commands, viewer leases and on-demand watches.
- `src/worker/main.ts`: Harness setup, IPC, prompt admission, resources, indexing and shutdown.
- `src/worker/subagents.ts`: persistent background conversations, reporter tasks, per-spawn model/thinking/tools. Models are captured in a closure pending upstream issue earendil-works/pi#10395.
- `src/shared/resources.ts`, `credentials.ts`, `locked-file.ts`, `provider-config.ts`: independent resource observation and provider/credential behavior.
- `src/server/shares.ts`: private SQLite share tokens/hashed guest credentials, join page, live permission evaluation. `src/shared/sharing.ts` defines roles and the temporary speaker header.
- `src/server/hosts.ts`, `http.ts`, `owner-access.ts`, `uploads.ts`, `web.ts`: host/origin checks, HTTP routes, owner authentication, file upload storage, Vite hosting.

One worker owns one session's Harness and storage. Server/workers observe resources independently; **no server-to-worker reload broadcasts**. Lifecycle commands serialize per session. Do not replace a worker until its previous process exits. Root transcript indexing uses acknowledged, paged immutable history, not ephemeral watches.

Conversation watches are acquired only while viewed, shared between viewers, and released when the last viewer switches/disconnects/expires. Task-graph/resource observation remains for liveness. Every browser connection views one `(sessionId, conversationId)` at a time; `1` is the main conversation.

## UI map

Read changed components fully:

- `App.tsx`: app shell, composer, session controls and panels.
- `client.ts`: browser connection, snapshots/Chord deltas, heartbeat, request correlation. `useSyncExternalStore` consumes immutable state.
- `transcript.ts`: display projection of Durable's view. Tool call IDs join assistant calls, live tool slots and final tool-result entries into **one card**.
- `Chat.tsx`: user/assistant messages, thinking, tools, subagent reports and copy actions.
- `Markdown.tsx`, `Code.tsx`: safe React rendering, lowlight token tree, clipboard helpers. Never inject untrusted HTML.
- `Drawer.tsx`, `ModelPicker.tsx`, `Sheet.tsx`, `LoginPanel.tsx`, `OwnerToken.tsx`, `Sharing.tsx`: navigation, sticky model/thinking controls, bottom sheets, provider login and owner-token generation.
- `style.css`: system light/dark theme, phone drawer/desktop sidebar, viewport and safe-area behavior.

Durable docs: `pi.agent`, `pi.live`, `pi.inbox`, `pi.usage`. During a generation, `pi.live.generation.message` is the committed partial; the root view carries exact Chord deltas. Tool output lives in `pi.live.tools`. The faux provider proves frontend streaming works; a provider may withhold text while reasoning or buffer its answer.

## Owner access and ngrok

- Localhost is trusted and automatically sets an owner cookie. Forwarded requests may not masquerade as localhost.
- Public HTTPS hosts must be explicitly listed in `PI_MOBILE_ALLOWED_HOSTS`; all other Host/Origin values are rejected. The server still binds IPv4 loopback only.
- Ngrok Basic auth has been removed. The app enforces owner access on remote UI/assets, uploads and WebSockets. Anonymous visitors get a token-entry page, not a password prompt.
- On the phone: sidebar → **Sign in another device → Copy token**. On the public domain: paste it and tap **Sign in**. Ten-minute expiry, one use. The private `owner-key` persists the owner cookie secret; `owner-token.txt` is a startup token. Never commit or log either.
- Provider login remains device-only. An owner controls the entire agent, including shell commands; it is not a sandbox.
- The tunnel is a Termux runit service: `$PREFIX/var/service/ngrok/run`, wrapping ngrok through proot Ubuntu, with `~/policy.yaml` bound to `/root/policy.yaml`. Domain and policy are local deployment config, not repository secrets.
- Check `sv status "$PREFIX/var/service/ngrok"` and `$PREFIX/var/log/ngrok/current`. Ngrok's local inspector is `http://127.0.0.1:4040`; it can contain credentials, cookies and prompt bodies—never dump it indiscriminately.
- Runit signals reach proot first. If a service restart leaves old ngrok alive, inspect exact PIDs and terminate the **ngrok child**, then confirm the new process loaded the policy.
- Never use broad `pgrep -f` output in `kill`: it can include the invoking shell. Inspect exact process identities/PIDs first. Never print passwords/cookies in command output or logs.

## Sharing and attribution

Owners open Session options → Share session. Links use the first allowed public host when configured. Guests get only that session and its subagents; no global resources, search, provider or model controls. Send permits uploads and arbitrary agent/tool actions, not filesystem isolation. Stop only aborts foreground work in the selected conversation, never kills a worker or crosses background scopes.

Expiry/revoke/reset disconnect old guest sockets, release watches, and invalidate subsequent HTTP/upload/WS authorization. Mute keeps read access but disables sending/stopping. Removing an identity cannot ban a person from a reusable bearer link; reset/revoke prevents joining from another browser. Persisted cookie identities/permissions survive server restart; a different browser joins independently. Already-admitted input/work is not rolled back.

Durable 1.0.0 input submission only creates `pi.user` from UserInput, without custom kind/data. Upstream issue **earendil-works/pi#10407**, labelled durable, requests custom entry input submission with steering/follow-up. Until supported, the worker prepends a **separate first text block** `<mobile-speaker>{kind,id,name}</mobile-speaker>` to model input. The UI parses only that first block and displays the remaining content literally. Never detect a sender by scanning user text or let a client supply author fields. Requests are deduplicated by server-assigned author ID plus client request ID, scoped to the conversation. Search excludes the header. Guest labels explicitly say guest; names are unverified. Tool-originated child requests/reports have no browser author header.

Direct browser prompts to a child do not create a new parent reporter; they appear in the child's own transcript. Existing subagent-tool requests retain background reporter behavior. Root Stop doesn't stop background children.

## Testing and quality

```sh
npm run check
node --test test/specific.test.ts
node --test --test-concurrency=1 test/*.test.ts
```

Run every changed test specifically; completion requires full `npm run check` output, fixing every diagnostic. Do not run `npm test` or `npm run build` unless explicitly requested. The check is Biome WASM plus TypeScript, **not tests**. Husky runs checks/tests on commits; keep its pre-commit file executable and never bypass it.

All agent tests use fake providers or localhost HTTP fixtures: no real keys, paid tokens or external provider requests. `PI_MOBILE_FAKE=1` is deterministic but **not a filesystem sandbox**; use temporary data directories and workspaces. Configured custom providers can still make real requests even in fake mode.

`test/dev.test.ts` copies the source into a temporary project, symlinks dependencies, and exercises worker/shared/server edits, manual restart, recovery, unviewed-worker restoration and HMR-only frontend changes. `test/sharing.test.ts` checks reusable joins, scoped actions/events/uploads, attribution, writable children, permission changes, removal/reset/revoke/expiry and backend-restart persistence. Other useful files: `integration.test.ts`, `server-crash.test.ts`, `resource-workers.test.ts`, `subagents.test.ts`, `uploads.test.ts`, `http.test.ts`, `web.test.ts`.

## Browser verification on Termux

Chromium is installed from Termux X11 (`chromium` package). Its ELF is `$PREFIX/lib/chromium/chrome`.

```sh
"$PREFIX/lib/chromium/chrome" \
  --browser-subprocess-path="$PREFIX/lib/chromium/chrome" \
  --headless=new --no-sandbox --no-zygote --disable-gpu \
  --user-data-dir="$TMPDIR/pi-browser-test" \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port=9340 about:blank
```

`--browser-subprocess-path` is essential: Termux `/proc/self/exe` re-exec fails under Android linker/LD_PRELOAD restrictions. Do not expose the debugging port through the tunnel. Use only trusted application pages with `--no-sandbox`.

Use Chrome DevTools Protocol over the target WebSocket (existing `ws` package) for navigation, clicks, `Runtime.evaluate`, and screenshots. Use `Emulation.setDeviceMetricsOverride` at 390×844, deviceScaleFactor 1–2, mobile true. CLI `--window-size` alone has a minimum desktop width; `--virtual-time-budget` gives misleading offline screenshots because it advances timers without real network progress. Poll actual DOM readiness instead of assuming fixed delays.

Test the local sidebar, token generation, public-domain token entry, and authenticated UI/WS with a fresh temporary profile. Do not print the token. A cold tunnel load of Vite's dev dependencies can be slow; wait for actual UI/connection readiness. Test light/dark, code highlighting, image loading (`complete && naturalWidth > 0`), tool expansion, model-sheet scrolling, and narrow viewports. Screenshot-only tests are not proof the real on-screen keyboard works; physical device checking remains useful.

Delete ad-hoc scripts/profiles/screenshots and stop Chromium afterwards. Don't delete other sessions' temporary files with broad globs.

## Git and deployment

Remote: private `badlogic/pi-mobile`; branch `main`. Do not commit/push unless requested. Stage explicit paths and check diffs for secrets, temporary scripts and runtime data. Don't override another session's edits. No force pushes, broad staging, resets or hook bypasses.

Backend changes require a running server restart; Vite HMR alone only reloads frontend files. Protocol changes must update backend and frontend together or stale server payloads can crash a new UI. In dev mode the supervisor handles backend restart; outside it, validate first and restart the exact server process with the same data directory/environment. Owner cookies persist; one-time tokens in memory do not. Sharing is an application authorization boundary, not a sandbox around tool execution.
