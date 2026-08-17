<!-- Hand-written repo guide for non-Claude agents (Codex etc.). NOT an athena-compiled
     artifact. Safe to edit. -->

# Agent instructions — athena

**Read `CLAUDE.md` in this directory in full before doing anything.** Despite its name it
is the canonical, tool-agnostic repo guide (what athena is, commands, gotchas,
boundaries) — this file is only a pointer plus the non-negotiables.

Non-negotiable rules (duplicated here in case you skip the pointer):

- Never push, tag, or create GitHub releases; never commit to `main` — feature branch
  (`agent/<tool>/<task-slug>`) + PR, conventional-commit messages (commitlint gates CI).
- Frozen contracts, breaking to rename: package scripts `lint`/`typecheck`/`test`; CI check
  names `ci / lint|typecheck|test|commits`; plain `vX.Y.Z` tag shape; the `ATHENA-COMPILED`
  output header format.
- Verify locally with `pnpm typecheck && pnpm lint && pnpm test` (CI only runs on GitHub).
  Every behavior change needs a regression test that fails before the fix.
- `pnpm compile <dir>` writes files INTO `<dir>` — never aim it at a repo you don't intend
  to modify. Keep all text files LF (`.gitattributes` enforces it; doctor compares
  settings byte-exactly).
- No new runtime components (queues, daemons, dashboards) — record the idea in
  `FOREMAN-NOTES.md` instead of building it.
