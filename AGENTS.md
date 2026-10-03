# Development Rules

Before development, read [DEV.md](DEV.md) completely for architecture, current limitations, restart/recovery, owner access, ngrok and Chromium workflows. Also read [DESIGN.md](DESIGN.md) and [README.md](README.md); never treat planned features as implemented.

## Conversational Style

- Keep answers short and concise. No emojis or cheerful filler.
- Use clear, simple technical language. Define unavoidable jargon.
- Explain non-trivial designs and problems with a concrete example, then the solution. Distinguish necessary changes from optional complexity.
- Answer questions before making edits or running implementation commands.
- When responding to feedback, explicitly say whether you agree or disagree before describing changes.

## Code Quality

- Read files in full before editing them, making wide-ranging changes, or investigating/auditing them. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check node_modules for external API types; don't guess.
- No inline imports (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- Never remove or downgrade code to fix type errors from outdated dependencies; upgrade the dependency instead.
- Use only erasable TypeScript syntax for Node strip-only mode: no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs requiring JS emit. Use explicit fields with constructor assignments.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- Follow `DESIGN.md` for project architecture and scope.

## Commands

- Every time you think you are done, run `npm run check` from the repository root, with full output (no tail). Fix all errors, warnings, and infos before reporting completion or committing. This command does not run tests. Do not silently substitute a partial check; report any environment blocker explicitly.
- Never run `npm run build` or `npm test` unless requested by the user.
- If you create or modify a test file, run that specific file and iterate on the test or implementation until it passes: `node --test test/specific.test.ts`.
- Use a fake provider for agent integration tests. No real provider APIs, keys, or paid tokens.
- When adding regression tests for a GitHub issue, add a comment with the issue number next to the test.
- For ad-hoc scripts, write them to a temporary file, run and edit if needed, then remove them. Use the environment's writable temporary directory (`$TMPDIR` on Termux); don't embed multi-line scripts in bash commands.
- Never commit unless the user asks.

## Dependency and Install Security

- Treat npm dependency and lockfile changes as reviewed code. Pin direct external dependencies to exact versions.
- Install/update locally with `npm install --ignore-scripts`; use `npm ci --ignore-scripts` for clean/CI installs. Don't run lifecycle scripts unless the user asks.
- If dependency metadata changes, refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.
- Review new dependency lifecycle scripts before running or allowing them.
- When updating `undici`, read the target version's changelog/release notes and evaluate functionality changes first.
- Never commit secrets, provider credentials, or runtime session data.

## Git

Multiple sessions may share this worktree. Do not overwrite or stage other sessions' work.

- Only commit files you changed in this session.
- Stage explicit paths; never `git add -A` or `git add .`.
- Before committing, run `git status` and verify that only your files are staged.
- Use concise, informative commit messages with `feat:`, `fix:`, or `docs:` prefixes.
- Never run `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, or `git commit --no-verify`.
- Resolve rebase conflicts only in files you modified. If a conflict is in another file, abort and ask the user.
- Never force push.
- When reviewing PRs, do not switch branches or check out the PR unless explicitly asked. Inspect metadata and diffs without changing the worktree.

## User Override

If the user's instructions conflict with a rule in this document, ask for explicit confirmation before overriding it.
