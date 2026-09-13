<!-- Hand-written repo guide. NOT an athena-compiled artifact (athena itself is not an
     athena-managed project — `pnpm compile` with no args fails on purpose). Safe to edit. -->

# athena — instruction compiler for agent-built repos

Small TypeScript CLI, no build step, no runtime services. It compiles layered agent
instructions into per-tool files (`CLAUDE.md`, `AGENTS.md`, `.claude/settings.json`) for
*other* repos, and detects drift in those repos. Part of the Artemis workspace — if the
parent directory has `CLAUDE.md`/`PROJECT-GUIDE.md`, read those for workspace-level rules
(polyrepo layout, boundaries, `check.ps1`/`verify.ps1` gates).

## The contract (what the code does)

- `pnpm compile <projectDir>` (`compile.ts`) reads the target's `.athena/config.json`
  (`{athenaVersion, stack, targets[], tools[]}`) and optional `.athena/project.md`, merges
  instruction layers in a fixed order, and **writes into `<projectDir>`**:
  - layers: `00-universal.md` + `10-security.md` + `20-stack-<stack>.md` + one
    `30-target-<t>.md` per target + `project.md` last (`resolveLayers` in compile.ts).
  - tool `claude` → `CLAUDE.md` + `.claude/settings.json` (verbatim copy of
    `permissions/t1.settings.json`) + one `.claude/commands/<name>.md` per entry in
    `COMMANDS` (verbatim copy of `commands/<name>.md`, currently just `conductor.md`);
    tool `codex` → `AGENTS.md` (same body, no settings and no commands).
  - each instruction output (CLAUDE.md / AGENTS.md) starts with a one-line header:
    `<!-- ATHENA-COMPILED <version> sha:<16-hex> — edit .athena/project.md ... -->`
    where the sha is sha256 of the body, truncated to 16 chars — deterministic, no
    timestamps. `compile()` itself is pure; `writeOutputs()` does the I/O.
  - `validateConfig` is shared with doctor: JSON must be an object, version a non-empty
    header token, stack/targets simple layer identifiers, and tools a non-empty known
    list. Duplicate targets/tools and path-like layer names are rejected.
  - unknown tool in `config.tools` → throws (KNOWN_TOOLS = `['claude','codex']`,
    compile.ts). No silent fallback — that's a regression guard, keep it.
- `pnpm doctor <projectDir>` (`doctor.ts`) is read-only; prints `PASS|FAIL <name> — detail`
  per check, exit 1 if any FAIL. There is no WARN tier. Checks: config present/parseable/
  well-shaped (unknown tools fail here too, parity with compile), layers resolvable,
  `CLAUDE.md`/`AGENTS.md` freshness, `.claude/settings.json` byte-equality vs the t1
  profile, and presence of `.github/ISSUE_TEMPLATE/task.yml`.
- `pnpm harness-lint` (`harness-lint.ts`) checks athena's own harness rather than a target
  repo — deterministic and offline, no agent and no network. Checks: every claim in
  `permissions/coherence.json` still holds (the layer states the command AND the named
  profiles cover that direct command prefix, or the claim is marked `advisory` with a
  reason); every flag-bearing
  deny rule carries a written acknowledgement (order-sensitive patterns are evadable —
  REVIEW-2026-07-15 #7); the worst-case compiled bundle stays under `BUNDLE_TOKEN_BUDGET`
  (4000; run harness-lint for the current estimate); and no rule line repeats inside one
  bundle. It also covers `commands/`: the directory must match `COMMANDS` exactly (an
  unlisted file never ships, a listed file that is absent makes compile throw), every command
  needs frontmatter carrying a description, no command repeats a line, and a same-named
  process doc at the repo root must reference `commands/<name>.md` — the mechanical version
  of conductor.md's "keep the two in step".
- **`harness-scorecard.json` is committed and verified, not merely printed.** `pnpm
  harness-lint` FAILs when it is stale; `pnpm harness-lint --write` regenerates it. It holds
  bundle cost per config, command cost, and coverage counts, so a change in any of them lands
  in the PR diff instead of only on the screen of whoever ran the CLI — the bundle grew ~20%
  across three sessions before this existed. Same idea as compile's content hash, aimed at
  the harness itself. It is excluded from biome in `biome.json`: a generated file the
  formatter also owns would ping-pong between `--write` and `biome check` forever.
  The inventories that never fail: per-config bundle cost, command cost, rules echoed across
  layers, lines a command shares with a layer, and deny rules no layer explains (11 today).
- **Freshness is hash-of-actual-body vs hash-of-recomputed-body** (isFresh in doctor.ts) — it does
  NOT trust the header's declared sha, so hand-edits below an intact header are caught.
  Editing any instruction layer, permission profile, or the target's `project.md` makes
  every downstream repo read as drifted until recompiled. That is by design.

## Commands (script contract is frozen — see Boundaries)

- `pnpm install --frozen-lockfile` · `pnpm typecheck` · `pnpm lint` (biome; prints a benign
  `linter.recommended` deprecation info, exits 0) · `pnpm test` (vitest + coverage)
- One file: `pnpm exec vitest run doctor.test.ts`
- `pnpm harness-lint` — no arguments; checks athena's own layers, profiles and commands.
- `pnpm harness-lint --write` — regenerate `harness-scorecard.json`, then commit the diff.
- `pnpm compile <dir>` / `pnpm doctor <dir>` — never point compile at a repo you don't
  intend to modify, and never at `../platform/templates/*` (it would dump rendered output
  into jinja sources).

## Map

- `compile.ts`, `doctor.ts` — the whole product. Tests live flat at root next to the code
  (`*.test.ts`); no `src/`, no `tests/`, no build (`tsx` runs TS directly).
- `instructions/` — the six canonical layers. `instructions.test.ts` auto-discovers `*.md`
  and enforces a **120-line cap per layer**. Valid `stack` values = existing
  `20-stack-*.md` files (ts, python); valid `targets` = `30-target-*.md` (workers,
  vscode-ext). Adding a file IS adding a valid config value.
- `permissions/` — Claude Code approval profiles: t0 reviewer, t1 author, t2 preview.
  **Only t1 is wired up** (`SETTINGS_PROFILE`); t0/t2 are unused today. General-purpose
  runners/interpreters require approval in normal manual mode; named development commands
  remain allowed. Direct secret-file reads are denied. These profiles are not sandboxes:
  approved scripts can spawn subprocesses, and alternate forms can evade command denies.
  `permissions/README.md` explains the boundary. `coherence.json` tests direct-prefix
  coverage, not runtime isolation, and is read only by harness-lint (compile ignores it).
- `commands/` — slash commands compile installs verbatim into `.claude/commands/` of every
  claude-enabled repo (`COMMANDS`, compile.ts). Currently just `conductor.md`. Byte-exact
  like the permission profile: doctor reports a local edit as drift. This is the
  operational twin of the `conductor.md` process doc at the repo root — edit both.
  harness-lint enforces the half of that which is mechanical: the doc must reference
  `commands/conductor.md`, and the directory must match `COMMANDS`.
- `conductor.md`, `task-packet.md`, `review-protocol.md`, `FOREMAN-NOTES.md` — process docs
  for multi-agent work (task packets, review rules, max-3-concurrency conductor pattern).
  FOREMAN-NOTES is the parking lot for out-of-scope runtime ideas (D-17/D-28).
- `.github/workflows/` — thin callers of `willzhu16/platform/.../{ci,security,codeql}.yml@v1`
  plus `release-athena.yml` (release-please) and `update-major-tag.yml` (moves the `v1` tag).

## Gotchas (verified 2026-07-11)

- `package.json` says version 0.0.0 — release-please's `.release-please-manifest.json` is
  the release version. Don't "fix" package.json.
- doctor checks for `.github/ISSUE_TEMPLATE/task.yml` but compile never creates it — the
  platform templates provide it in generated repos. A bare compile target will FAIL that
  one check until the file exists.
- The `review` field in `AthenaConfig` is typed but read by nothing — dead config.
- Tool `codex` gets no permission profile and no commands; both are claude-only.
- `.gitattributes` forces LF everywhere; doctor's verbatim checks are byte-exact, so CRLF
  anywhere in `.claude/settings.json`, `.claude/commands/*`, the profiles or `commands/`
  reads as drift. Keep LF.
- Conventional commits enforced in CI by commitlint (`.commitlintrc.json`); branch names
  for agent work follow `agent/<tool>/<task-slug>` per `00-universal.md`.

## Boundaries

- Frozen cross-repo contracts (breaking to rename, D-18): package scripts
  `lint`/`typecheck`/`test`; CI check names `ci / lint|typecheck|test|commits`; plain
  `vX.Y.Z` tag shape; the `ATHENA-COMPILED` header format that doctor parses.
- Never push, tag, or create releases here — tags drive release-please and the moving `v1`
  pin downstream repos consume. Never commit to `main`; feature branch + PR.
- Every behavior change ships with a regression test that fails before the fix.
- Do not add runtime components (queues, daemons, dashboards) — log the idea in
  `FOREMAN-NOTES.md` instead. Do not raise the conductor concurrency cap (3).
