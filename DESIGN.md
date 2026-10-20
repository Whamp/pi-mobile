# Pi Mobile design

Status: server/workers, shared resources, localhost provider login, and a minimal React/Vite UI are implemented and tested. Sections marked later remain design decisions, not implemented features.

## Goal

A lightweight, mobile-first web home for Pi Durable, running in Termux. Eventually the user can chat with an agent in the browser, ask it to edit this project's sources, and see UI changes through Vite hot reload.

Keep the implementation small: simple primitives, plain typed messages, no speculative frameworks, generic transport layers, or elaborate defensive abstractions. Authentication and necessary isolation still matter before exposing agent control remotely.

## Project

- Single package: TypeScript + Node, ESM.
- Project directory: `~/pi-mobile`.
- Persistent application data: `~/.pi/mobile/`, separate from source.
- Reuse Pi's general Biome/Husky/TypeScript conventions, adapted to one package.
- Termux tooling: native Biome 2.3.5 and TypeScript 7 lack Android ARM64 binaries. Use Biome's Node WASM bindings for per-file syntax/lint/assist/format checks and portable TypeScript 5.9.3 for type checking. `npm run check` runs both on Termux; see README for WASM limitations.
- Runtime foundations: `@earendil-works/pi-durable` and `@earendil-works/pi-ai`.
- No dependency on `pi-coding-agent`, and do not use Pi's server/client packages.
- Copy and simplify relevant coding-agent implementations with attribution and their useful tests when needed; do not copy its overloaded settings manager.
- Coding tools and durable codemode use Pi 1.3.0. Codemode runs in a 128 MiB
  QuickJS sandbox on a worker thread. No script timeout is supplied by the host.
- GitHub repository: `badlogic/pi-mobile`, created and configured as `origin`. Source is committed and pushed; development continues on main.

Suggested layout:

```text
src/
  server/   # catalog, search, HTTP/WebSocket, worker lifecycle
  worker/   # independent Durable runtime
  shared/   # protocol and shared resource/config helpers
  web/      # React UI and browser state
 test/
```

## Server responsibilities

- Own session catalog and search index.
- Manage worker process creation and termination.
- Host the web UI on a configurable port.
- Route user actions to workers and session state back to clients.
- Track which sessions clients are viewing through heartbeats.
- Observe the server's own settings/model/credential resources independently.
- Bridge provider-owned localhost login and explicit model refresh.
- Do not coordinate worker resource reloads or broadcast configuration changes to workers.

## Session catalog and UX

- Sessions have stable IDs and exist independently of their worker processes.
- List available sessions; show archived sessions through a separate "Archived sessions" entry below the normal list.
- Group sessions by normalized absolute working directory.
- Allow pinning, searching, archiving, restoring, and editing titles.
- Creation selects a working directory, optionally creates it, creates storage, and starts a worker immediately.
- Derive the initial title from the first user message; titles remain editable.
- Archiving stops the worker, preserves storage/history, and hides the session from the available list.
- Restoring returns it to the available list; opening it starts a worker if necessary.
- Opening an already-running session attaches to its current state.
- Search-scope details and exact sorting within cwd groups can be settled with the UI later.

Persisted catalog metadata:

- Session ID, title, cwd.
- Creation time, last activity time, archived time/status.
- Pinned status/order.
- Last-message preview if useful.

Worker PID, running/busy state, and current process errors are live server state, not authoritative persisted session metadata.

## Workers and lifecycle

- One separate Node process per running session.
- Each worker exclusively owns that session's Durable Harness and storage.
- Reopening storage resumes unfinished Durable work.
- Server startup reads the catalog but starts **no workers**.
- Existing workers start lazily when a user opens a session.
- Closing/disconnecting the browser does not interrupt ongoing work.
- Keep a worker alive while any client views it or while any foreground/background task exists.
- Once both unviewed and task-idle, begin a five-minute shutdown timer.
- Viewing the session or starting work cancels that timer.
- Heartbeats expire stale viewers, so vanished clients cannot keep workers alive forever.
- Archive stops a worker regardless of viewers/tasks.
- Server shutdown kills workers rather than waiting for agent work to finish. Preserve unfinished work, do not semantically abort it first.
- Durable recovery preserves committed state; this does not guarantee arbitrary external tool effects are exactly-once.
- Ensure an old worker has exited before starting another owner of the same session storage.

## Communication

- Server ↔ worker: Node IPC, plain typed commands/responses/events.
- Browser ↔ server: WebSocket, plain typed messages.
- Do not add a transport abstraction initially. SSE plus command endpoints could be added later only if needed.
- Operations include session creation/opening, pin/archive/restore/rename/search, viewed-session heartbeats, prompt/steer/follow-up/abort, and state subscription.
- New connections get current snapshots, then live updates.
- Reconnect obtains fresh state; it must not blindly resend user input. Use Durable submission request IDs for duplicate-safe admission where appropriate.

## Storage and search

- SQLite catalog + full-text index, available without starting workers.
- Each session gets separate Durable SQLite storage.
- Durable is the authoritative source for transcript and task state.
- Index root-conversation **user and assistant text**, not thinking, tool arguments/results, or every streamed partial.
- Index committed transcript messages, including assistant turns that use tools when they contain text.
- Retain searchable history across compaction, stopped workers, and archiving.
- Message index includes session/conversation/entry IDs, role, timestamp, text, and ordering/catch-up cursor information.
- Stable entry IDs make indexing idempotent.
- Workers supply committed messages to the server; indexing must catch up after interruption, not rely solely on ephemeral live events.
- Search index is derived/rebuildable; maintain an index/schema version.
- Search also includes session metadata such as title/cwd, with creation/archive state available as filters and result metadata.
- Root-only indexing initially. Subagents come later.
- Confirm Node SQLite/FTS5 support in Termux during implementation.

## Settings, models, credentials, and resources

Resource foundation and localhost login are implemented:

- Own small validated settings store: default model/thinking and relevant Durable runtime preferences.
- Credentials are separate from ordinary settings, transcripts, and search data.
- Reuse/copy Pi's tested cross-process-locking credential store and relevant tests; avoid inventing a new refresh-locking scheme. The existing implementation writes in place, not via atomic file replacement.
- Preserve useful `models.json` behavior: custom/local endpoints, definitions, overrides, headers, compatibility flags, and credential environment/command resolution.
- Parsing alone is insufficient: also reuse/simplify the required provider-composition/runtime behavior.
- Use provider-owned pi-ai login/refresh flows. Do not implement OAuth exchanges ourselves.
- Current pi-ai credential contract stores one credential per provider: API key and OAuth are alternatives for that provider.
- Server handles login/logout UI. Workers independently resolve/refresh credentials from the shared locked store.
- Provider secrets stay off client state snapshots and logs.

### Independent resource observation

Automatic reload is a requirement, not a manual `/reload` workflow:

- Server observes the settings/model/credential resources it needs.
- Each worker independently observes its own applicable settings, models, credentials, AGENTS.md files, and skills.
- Share watcher/discovery/validation implementation, not a centralized server reload coordinator.
- Handle file creation, deletion, and atomic-save renames; debounce changes.
- Validate before applying; keep last valid state and report errors.
- In-flight requests/tool calls keep their existing configuration; later work sees updates.
- Check resources on worker startup too, including changes made while stopped.

### Provider login

- Initially expose provider login only through the localhost web UI.
- Postpone login through external domains/tunnels.
- Bridge pi-ai `AuthInteraction` prompts/events to browser inputs, choices, links, codes, and progress.
- Respect whole-flow and per-prompt cancellation; callback success can cancel a pending manual-input prompt.
- Several flows bind localhost callback ports; avoid concurrent conflicts.
- External callback handling may later need a per-login pi-ai callback option. Whether arbitrary public redirect URIs are accepted depends on each provider's OAuth registration, not just our code.
- Keep device-code/copy-code/manual-URL fallback options where supported.

## Web UI

- React + Vite, mobile-first and minimal.
- Plain CSS, small shared primitives, theme variables; no large component library or global state framework initially.
- Light/dark styling, initially following system preference.
- Chat streaming, stop/steer/follow-up, reconnect, session catalog/search.
- Pi-inspired tool rendering: compact call summaries, running/success/error states, expandable output, edit diffs, and images where supported.
- Artifact tool/panel for HTML, SVG, and documents. Artifacts should be persisted/updateable and previews isolated from chat/credentials.
- Interactive artifact-to-agent messaging and artifact scope are not yet decided.
- Vite HMR updates UI sources during agent work. `npm run dev` supervises the backend outside all workers; backend/shared/worker source changes gracefully recycle the server and resume all previously running workers, including unviewed/background sessions, without resubmitting prompts. Browsers reconnect from snapshots. Normal `npm start` still starts no workers. See DEV.md.
- Remote HTTPS hosts are listed in `PI_MOBILE_ALLOWED_HOSTS`. The app requires owner authentication before serving remote UI/assets, uploads or WebSockets; ngrok Basic auth is no longer needed. The local UI hands out one-time owner tokens. The public landing page asks for that token; it expires after ten minutes and is consumed through same-origin POST, never placed in a URL. Secure/HttpOnly/SameSite cookies persist for 30 days using a private owner key. Localhost remains trusted, but forwarded localhost Host headers are rejected. Provider login remains device-only. Session sharing is implemented separately: reusable links, per-browser unverified names/stable IDs, view/send/upload/Stop permissions, expiry and revoke/reset/mute/remove. Server-side authorization scopes HTTP/uploads/WS actions and events to that session and its subagents. Send can invoke unrestricted agent tools; it is not filesystem isolation.

## Subagents

- Base implementation on Durable's background-subagent example.
- Configure model, thinking level, and offered tools per subagent.
- Background tasks count toward worker liveness even when the browser disconnects.
- Implemented in `src/worker/subagents.ts`; the catalog records each session's subagents for the sidebar. Subagent conversations are not search-indexed yet.
- Owners and send-authorized guests can prompt/steer/queue follow-ups directly in child conversations. Direct browser input remains in that child; tool-created background reporters still relay their answers to the parent. Session/subagent URLs support back/forward navigation.
- Conversation watches are on demand: the server keeps one worker watch per conversation some client views, and each connection views exactly one conversation. Switching sessions/subagents releases the old watch.

## First implementation milestone

Server + workers first, not the React UI or provider login:

1. SQLite session catalog/index and metadata operations.
2. Process-per-session Durable worker with basic coding tools.
3. Node IPC and WebSocket API.
4. Viewing heartbeats and five-minute idle/unviewed shutdown.
5. Root-message indexing with catch-up.
6. Tests using a fake provider: create/open, prompt/state streaming, archive/restore, process lifecycle, kill/reopen recovery, and search.

Do not claim login, resource reload, artifacts, or subagents are present until implemented and tested.

## Current implementation state

The localhost page hosts a mobile-first React UI through Vite middleware, with `/health` and a cookie-protected `/ws` API. Vite's HMR socket passes the same loopback/cookie/Origin gate. Source modules hot reload without restarting workers; full dependency installation is currently required, and production bundling is not implemented. The catalog, FTS index, worker manager, Durable workers, snapshots/deltas, heartbeat leases, and five-minute idle shutdown are implemented. `src/shared/protocol.ts` defines the API; README describes running real environment-key sessions or the explicit fake-provider demo.

Workers send paged root-history index batches; the server commits each before acknowledgement. The catch-up cursor advances only after the entire bounded range has committed, so interrupted scans retry idempotently. Rebuilding an archived index uses a temporary worker with task scheduling paused. Search can lag after a crash until open/rebuild catches it up.

One server owns a data directory. Kernel socket locks protect that ownership and each worker's session storage, including during IPC-disconnect cleanup after a server crash. Replacement waits for prior ownership to end. Orderly worker termination seals Harness scheduling (without semantic task abort), reaps shell processes, drains credential lock acquisitions, and exits with a bounded forced-exit fallback. SIGKILL does not promise cleanup or exactly-once external effects; a killed credential-lock owner can require waiting for Pi's 30-second stale-lock window.

Tests use fake providers and temporary directories: create/open/prompt, all coding tools and cwd isolation, stream deltas, request-ID deduplication, archive/restore, viewer expiry and background-task liveness, worker/server crash recovery, indexed historical entries after compaction/reset, interrupted index acknowledgements, and HTTP/WebSocket validation. `npm run check` checks source and test types plus Biome WASM; no paid provider calls are used.

The resource foundation now provides validated `settings.json`, a persistent `auth.json` CredentialStore using Pi's async proper-lockfile refresh/write behavior, and credential-blind `models.json` validation/composition. Custom chat definitions, endpoints, headers, compatibility/input-limit merges, costs, model overrides, scoped environment interpolation, and trusted key/header commands are supported. Provider-owned Pi AI code performs locked OAuth refresh. Adapted sources/tests are attributed via `third-party/pi.LICENSE`.

Server and workers each own a resource observer: 500 ms polling, coalescing across two polls, validation before publication, last-valid live state on errors, and startup checks. No server-to-worker reload instructions exist. Workers additionally load mobile/global and cwd-ancestor AGENTS.md files and skill metadata under mobile `skills/` and cwd `.pi/skills/`. Resource updates replace prompt sections through the worker's registry; in-flight requests retain their captured configuration. The WebSocket `resources`/`setSettings` actions and server resource events expose only non-secret settings/model/provider summaries, credential types, and sanitized errors. Worker resource errors remain ephemeral status.

Additional tests cover two-process OAuth refresh, failed refresh without environment fallback, modes/in-place writes, compromised/cancelled locks, draining abandoned acquisitions on shutdown, scoped header resolution and precedence, local OpenAI-compatible dispatch, frozen in-flight configuration, file creation/deletion/atomic replacement, and worker reload while the server observer is deliberately stopped.

The browser derives a display model from the Durable view (`src/web/transcript.ts`): each assistant tool call is joined with its `pi.live` slot and result entry, so one card shows pending/running output and then the result; the committed `pi.live` generation partial renders as the streaming answer. It implements a drawer with cwd-grouped sessions and search, safe Markdown, thinking, edit diffs, images, follow-up/steer/foreground abort, queued inputs, a per-session model/thinking picker (`configure` commits `pi.agent`), saved defaults, heartbeat leases, and reconnect with fresh snapshots and no automatic input replay. It follows system light/dark preference. Layout was verified with headless Chromium screenshots (Termux needs `--browser-subprocess-path` pointing at the chrome binary). Assistant answers and code blocks have copy buttons; fenced code and read/write tool content are highlighted (lowlight, rendered as React elements). Uploads are stored under the data directory per session and attached by path (images inline for image-capable models). Artifacts remain later.

The composer defaults to steering and keeps Stop visible while editing. Queued inputs can be withdrawn back into the draft or discarded. Stop delivers text-only drafts to the original browser authors' connected sockets; these drafts are not persisted for disconnected users or scoped to the receiver's current view, and concurrent queue arrivals are not atomically recovered. The bottom usage line totals all session conversations, subagents, tools and compaction; its separate context percentage estimates only the viewed conversation against the active model's live limit. Model search stays within providers with stored credentials. Thinking is collapsed by default even while live; Copy is attached to assistant text.

Localhost provider access bridges Pi AI prompts/events to the initiating socket only, with select validation, callback/manual-input cancellation, API-key/OAuth storage, logout, a stable device ID, and explicit network-enabled model refresh. A single active login avoids callback-port collisions; disconnect/cancel/close/deadline stop unfinished flows. Completed login is not undone if catalog refresh fails. Provider-owned catalogs persist in a shared locked store, restore offline, and are observed independently by server/workers. Tests use fake login flows, including callback success while manual input is pending; no real external login or paid request was performed.

The small resource layer does not implement extension providers, custom OAuth catalogs, symlink/ignore-aware or externally configured skill discovery, or slash-command skill invocation; README records the supported subset.

An earlier abandoned SDK draft lives outside this project at `~/pi-web`; it is not the basis of this Durable implementation.
