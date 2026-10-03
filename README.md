# pi-mobile

Lightweight, mobile-first host for Pi Durable, running in Termux. Includes a React/Vite browser UI, independent session workers, shared configuration resources, and localhost provider login.

## Run

Requires Node 22.19 or newer and Git.

```sh
npm install --ignore-scripts
npm start
```

For self-editing development, use `npm run dev`: frontend edits use Vite HMR; server/shared/worker edits recycle the backend and resume every previously running worker from Durable state. Manual restart: `kill -USR2 "$PI_MOBILE_DEV_SUPERVISOR_PID"`. See [DEV.md](DEV.md) for the full workflow and recovery limitations.

Open http://127.0.0.1:8787. Override the port with `PORT=9000`; `PORT=0` chooses a free port. Data lives under `~/.pi/mobile/`; override it with `PI_MOBILE_DATA_DIR`.

Open **Providers** in the session drawer to sign in. A new session starts when you send the first message; pick its directory on the start screen. The model chip in the composer changes model and thinking level, including mid-session (the next request uses it). **Use this model for new sessions** in the session menu saves defaults. Optional API environment defaults:

```sh
PI_MOBILE_PROVIDER=openai PI_MOBILE_MODEL=gpt-4o-mini npm start
```

Pi AI resolves credentials from the shared `auth.json` store or provider environment variables inherited by workers. The stored credential owns its provider; failed OAuth refresh does not fall back to an environment key. The browser sends entered login values directly to the provider-owned flow on the local server; persisted keys/tokens are never returned in resource snapshots or login results.

For demos using the fake provider:

```sh
PI_MOBILE_FAKE=1 npm start
```

Fake mode supplies a fake base catalog (explicitly configured custom providers can still make real requests). It echoes prompts; `slow ...` streams a longer answer. Its `tool`, `write`, `edit`, `bash`, and `slow-tool` prompts exercise real coding tools: read `fixture.txt`, write/edit `created.txt`, run `pwd`, or run a short sleep command, respectively. **Fake mode is not a filesystem sandbox.**

The server binds only IPv4 loopback. Host/origin checks and a per-server HttpOnly/SameSite cookie protect browser agent actions; any other Host header is rejected (DNS rebinding). Other local processes are trusted.

**Tunnels.** Allow the HTTPS tunnel host and sign in using a one-time owner token. Ngrok basic auth is not required:

```sh
PI_MOBILE_ALLOWED_HOSTS=pim.ngrok.pro npm start   # comma-separated
```

Allowed hosts are treated as `https://<host>` origins. Remote UI/assets, uploads and WebSockets require an owner or session-scoped guest cookie; anonymous visitors see a sign-in-required page, not a Basic-auth prompt. The cookie is HttpOnly/SameSite=Strict/Secure and lasts 30 days. Localhost still grants owner access automatically; forwarded requests cannot impersonate localhost.

On the phone, open the local UI's sidebar and choose **Sign in another device → Copy token**. Open Pi's domain on the other device, paste the token into the landing page, and tap **Sign in**. Tokens expire after ten minutes and work once. The local `GET /owner-token` endpoint generates them using the localhost owner cookie; tokens are never put in URLs. At startup a token is also saved privately in `~/.pi/mobile/owner-token.txt` (0600). Claiming requires same-origin POST and consumes the token once. The private `owner-key` file persists the owner credential across server restarts. Anyone signed in as owner controls the agent, including shell commands. Provider login stays device-only. Owner access is separate from session-scoped guest sharing below.

## Sharing

Open a session → **Session options → Share session…**. Create a reusable link and copy it. The configured public HTTPS host is used automatically; without one, the link is local-only. Each guest chooses a name and receives an independent browser identity. Names are unverified; badges and colours distinguish guests from the owner.

Default access is view-only. **Allow sending messages and uploads** enables prompting, steering and follow-ups in the main conversation and all its subagents. **Allow stopping the current run** is independent. Sending can make the agent execute shell commands or read/write files; this is **not filesystem isolation**. Guests cannot create sessions, search other sessions, change models/settings, manage providers, archive/reset/kill workers, or access owner tokens.

Permissions update on existing connections. Expiry/revoke disconnect guests; resetting changes the link and disconnects every old guest. Mute disables sending and stopping while retaining viewing. Removal blocks that browser identity, not a person: anyone still holding a reusable link can join from another browser. Reset/revoke the link to prevent rejoining. Already downloaded messages cannot be taken back, and admitted work is not cancelled by changing access.

Share tokens and hashed guest credentials persist privately in `shares.sqlite` across backend restarts. Shared URLs contain the bearer share token; treat the link and tunnel request logs as sensitive. Owner sign-in tokens remain single-use and are never put in URLs.

Session and subagent views have URLs (`/s/<session-id>`, `/s/<session-id>/a/<conversation-id>`), including browser back/forward navigation. An owner cookie always takes precedence over a guest cookie in the same browser.

## Implemented

- SQLite session catalog, cwd grouping/order, pins, editable first-input titles, archive/restore, and FTS search.
- One Durable process and separate SQLite storage per running session, with read/write/edit/bash tools.
- Node IPC and a typed WebSocket API with committed snapshots and Chord operation batches.
- New sessions start immediately; existing sessions start on open. Server startup starts none.
- Heartbeats keep viewed workers alive. Five minutes without viewers **and** any foreground/background task stops a worker. Viewer leases expire after 45 seconds.
- Disconnects leave work running. Stop/archive/server shutdown terminate processes without semantically aborting Durable tasks. Open resumes committed work.
- Kernel socket locks prevent overlapping servers/storage owners, including after a server crash. Termux/Linux use abstract sockets, automatically released on process exit. Other Unix platforms use temporary socket files; an unclean exit may require removing stale socket files after confirming no owner remains.
- Root user/assistant text indexing, stable entry IDs, acknowledged batches, bounded catch-up scans, and explicit index rebuilding. Thinking and tool results are excluded; historical entries remain searchable after reset/compaction.
- Validated settings, a shared locked credential store, custom models.json composition, persisted dynamic catalogs, and independent server/worker resource observation. Workers also load applicable AGENTS.md and skill descriptions.
- Mobile-first React UI: drawer with cwd-grouped sessions, pins/archive/restore, session and message search; live streamed Markdown answers and thinking; one card per tool call following it from pending/running (with output preview) to its result, with edit diffs and images; follow-up/steer/stop and queued-input display; bottom-sheet model/thinking picker per session; system light/dark styling; and Vite hot reload.
- Provider-owned API-key/OAuth login with prompts, choices, links, device/manual codes, progress, cancellation, logout, and explicit model refresh. One login at a time avoids callback-port conflicts.

Indexing is asynchronous. After a crash, the index may lag until the session is opened or rebuilt. Rebuilding restarts a running worker; an archived session is scanned with scheduling paused, then stopped again. SQLite WAL handles process crashes; power-loss guarantees and exactly-once external tool effects are not implied. Orderly worker termination reaps its shell processes; a worker SIGKILL can leave external effects/processes behind.

Artifacts remain unimplemented. Markdown is a small safe subset (no tables or HTML); fenced code and file tool output are syntax highlighted with lowlight/highlight.js, rendered as React elements rather than HTML. The UI runs through Vite middleware, not a production bundle; install dev dependencies too. Layout was checked with headless Chromium at phone and desktop sizes, not on a physical device. See [DESIGN.md](DESIGN.md).

## Subagents

The agent has a `subagent` tool (adapted from Durable's background-subagent example): `spawn` with `name`, `message`, optional `model` (`provider/modelId`), `thinkingLevel` (clamped to the model) and `tools` (subset of read/write/edit/bash); `send` (steer, or `followUp`); `stop`; `status`; and `models` (models with configured credentials). Subagents are background Durable conversations: the main agent's Stop doesn't reach them, they keep the worker alive, survive restarts, cannot spawn subagents, and report each answer back to the main conversation as a follow-up input. The sidebar lists them under their session; opening one shows its transcript, configuration, composer and stop button (subject to guest permissions). Direct browser inputs stay in that child conversation; tool-submitted requests still use the existing parent reporter. Search indexes the main conversation only.

Durable's tool API does not expose the Harness `Models` yet (earendil-works/pi#10395), so the worker passes its instance to the tool.

## Uploads

The composer's paperclip attaches files. They are uploaded on send to `~/.pi/mobile/uploads/<session-id>/<id>-<name>` (mode 0600), never into the project. The message tells the agent each absolute path; images (PNG/JPEG/GIF/WebP ≤ 5 MB) are also inlined when the session model accepts image input. Durable's read tool cannot read image files yet. Uploads are not deleted automatically.

## Settings, models, credentials, and reload

Resources live under `~/.pi/mobile/` (or `PI_MOBILE_DATA_DIR`):

- `settings.json`: default model/thinking, stream timeout/transport/cache options, retry/compaction policy, tool execution and queue modes. Unknown fields are rejected; credentials do not belong here. Missing settings use Durable defaults.
- `models.json`: Pi-style `providers` with custom chat definitions, endpoint overrides, provider/model headers, compatibility settings, thinking mappings, costs, and `modelOverrides`. JSON line comments and trailing commas are supported. Standalone custom providers support OpenAI Completions/Responses, Anthropic Messages, and Google Generative AI; built-in providers retain their own implementations. Extension providers and custom OAuth catalogs are not included.
- `auth.json`: one canonical API-key or OAuth credential per provider, using Pi AI's credential contract. Pi's async proper-lockfile refresh/write mechanism is adapted with attribution in `third-party/pi.LICENSE`; writes stay in-place, new files are owner-only, and existing modes are preserved. Provider-owned Pi AI code handles refresh. A killed lock owner can require waiting for the 30-second stale-lock window; normal shutdown drains lock acquisitions before exit.

- `models-store.json`: provider-owned dynamic catalog cache, restored without network access on server/worker startup. Login and **Refresh models** explicitly allow a provider catalog fetch; cache changes are independently observed by each worker. Logout removes that provider's cache.
- `device.json`: a stable installation ID supplied to provider login flows that request it; not a credential.

Login prompts/events are sent only to the initiating WebSocket connection. Disconnecting, cancelling, or closing the access panel cancels unfinished login; the whole-flow deadline is ten minutes. Provider callback success can withdraw a manual-code prompt. OAuth callback ports and external provider pages remain provider-owned. Model refresh failure does not undo a completed login. No real external login was performed during automated tests.

API-key/header values support literals, `$ENV_VAR` / `${ENV_VAR}` interpolation, and trusted local `!shell commands` (10-second limit). Credential-scoped environment values take precedence for interpolation. Model overrides merge nested compatibility/input limits rather than discarding inherited fields. Request headers override configured headers; `transformHeaders` runs last. Treat these local files as executable configuration, not untrusted uploads.

Example `settings.json`:

```json
{
  "defaultModel": { "provider": "openai", "modelId": "gpt-4o-mini" },
  "thinkingLevel": "off",
  "stream": { "timeoutMs": 120000 },
  "toolExecution": "parallel"
}
```

Explicit session choices override file defaults, which override environment defaults. Default model/thinking changes affect new sessions; existing sessions retain their saved agent choices. Runtime policy getters apply at Durable decision boundaries.

Each process polls its own resources every 500 ms and coalesces changes across two polls. Creation, deletion, and atomic-save renames are observed. Invalid edits retain the last valid live configuration and report non-secret errors; invalid initial credentials fail closed. Requests already in progress keep their configuration generation. No server-to-worker reload broadcasts are used.

Workers read `AGENTS.md` in the mobile data directory and along cwd's ancestry. Skills are recursively discovered as `SKILL.md` under mobile `skills/` and cwd's `.pi/skills/`; YAML name/description metadata is validated, with `disable-model-invocation` respected. Skill bodies are loaded through the read tool when needed. Symlink traversal, ignore-file handling, external skill paths, and slash-command invocation are not included. Instruction-file and skill changes made while stopped are checked at startup.

The `resources` API exposes only validated settings, known model/provider summaries, credential **types**, and sanitized errors—not keys, tokens, headers, endpoints, or key-command output. It lists known models, not an auth-filtered availability catalog, and does not execute key commands while enumerating credentials.

## WebSocket API

Visit `/` first to obtain the local cookie, then connect to `/ws`. Browser cookies are automatic; local command-line clients send the cookie returned by `GET /`. A supplied Origin must match the connection's HTTP origin.

Requests are `{ id, action }`; replies are `{ type: "result", id, data?, error? }`. The request ID correlates replies. A prompt's separate `requestId` deduplicates Durable admission across reconnects/restarts. Do not blindly resend prompts on reconnect.

Actions and events are defined in `src/shared/protocol.ts`:

- `list`, `create`, `open`, `rename`, `pin`, `archive`, `restore`, `search`.
- `login` with `providerId`/`authType`, `loginAnswer` with `attemptId`/`promptId`/`value`, and `cancelLogin` bridge provider interaction. `logout` removes stored credentials; `refreshModels` explicitly refreshes a provider catalog. Owner-only `login` events are defined in `src/shared/login-protocol.ts`.
- `resources` reads non-secret configuration/model status. `setSettings` replaces the validated settings object and persists it; workers observe the file independently.
- `heartbeat` with the opened `sessionId`, every ~15 seconds; `sessionId: null` leaves the view.
- `prompt` with `content`, `requestId`, and optional `conversationId` and `whenBusy: "steer" | "followUp" | "reject"`.
- `configure` with optional `model`/`thinkingLevel` changes a session's agent; in-flight requests keep their configuration.
- `open` takes an optional `conversationId` (subagent conversations from the session's `subagents`). Each connection watches exactly one conversation; opening another or `heartbeat` with `sessionId: null` releases the previous worker watch.
- `prompt` accepts `attachments`: IDs returned by `POST /upload?session=<id>&name=<file>` (raw body, 25 MB limit, local cookie and same-origin `Origin` required).
- `abort` cancels foreground work; optional `background: true` includes background work. `stop` kills the worker, preserving unfinished tasks. `reset` starts a new context without deleting history.
- `rebuildIndex` rebuilds one session's derived text index.

Connections first receive `access` (owner or scoped guest), then a `catalog` event. Owner-only `shareGet`, `shareSet`, `shareGuest`, and `shareRevoke` manage sharing. Guest catalogs/events/actions are filtered server-side to the shared session; resource/provider events are never emitted to guests. `open` sends a `snapshot`, then `view` events with exact Chord `ops`; apply these with `applyImmutable` from `@earendil-works/chord/delta`. A new snapshot replaces the old view. `worker` events report ephemeral PID/task/error state, including worker resource errors. `resources` events publish the server's own non-secret resource snapshot when it changes. Reopen after a stopped worker or reconnect to obtain fresh state. Search returns matching session metadata plus up to 100 message hits; `archived: true` searches archived sessions separately.

Example from the localhost page's browser console, with fake mode enabled:

```js
const ws = new WebSocket(`ws://${location.host}/ws`);
ws.onmessage = (event) => console.log(JSON.parse(event.data));
const send = (id, action) => ws.send(JSON.stringify({ id, action }));
ws.onopen = () => send("create", { type: "create", cwd: "~/pi-mobile" });
// Copy the session ID from the create result:
// send("open", { type: "open", sessionId: "..." });
// send("prompt", { type: "prompt", sessionId: "...", content: "hello", requestId: "hello-1" });
```

## Tooling and tests

Single TypeScript/Node package, with development rules in [AGENTS.md](AGENTS.md). `npm run check` checks Biome and types, including tests; it must pass before reporting completion. `npm run format` applies safe fixes and formatting. Husky runs checks and tests before commits; after an ignore-scripts install, explicitly enable hooks with `npm run prepare` when wanted.

Biome 2.3.5 uses its Node WASM bindings on Termux. The runner uses Git's tracked/untracked file list (respecting `.gitignore`) and `biome.json` include patterns. It checks per-file syntax, lint, assists/import ordering, and formatting, not the native CLI's project/module scanning. The JS API is alpha. Only the WASM build's spurious schema-version diagnostic is suppressed (it reports version `0.0.0`). TypeScript is pinned to portable 5.9.3 because Pi's native TypeScript compiler lacks an Android ARM64 binary.

`npm test` runs fake-provider tests plus an OpenAI-compatible HTTP fixture bound only to localhost—no paid/external provider calls. Coverage includes HTTP/WebSocket protections, catalog/FTS transactions, coding tools, process isolation, heartbeat/idle/background lifecycle, Durable crash recovery, pre-compaction history, interrupted index acknowledgements, two-process OAuth refresh, credential permissions/cancellation, model composition/header precedence, frozen in-flight configuration, independent worker resource reloads, fake API-key/OAuth interactions and callback races, cancellation/ownership/deadlines, persisted catalogs, Vite transforms, and transcript HTML escaping. Tests use temporary data directories, not your sessions.

The private remote is `badlogic/pi-mobile`. No dependency on pi-coding-agent, pi-server, pi-client, MCP, or codemode.
