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
  (`{athenaVersion, stack, targets[], tools[], tier?}`) and optional `.athena/project.md`, merges
  instruction layers in a fixed order, and **writes into `<projectDir>`**:
  - layers: `00-universal.md` + `10-security.md` + `20-stack-<stack>.md` + one
    `30-target-<t>.md` per target + `project.md` last (`resolveLayers` in compile.ts).
  - tool `claude` → `CLAUDE.md` + `.claude/settings.json` (verbatim copy of
    `permissions/t<tier>.settings.json`) + one `.claude/commands/<name>.md` per entry in
    `COMMANDS` (verbatim copy of `commands/<name>.md`, currently just `conductor.md`) +
    one `.claude/hooks/<name>` per entry in `HOOKS` (verbatim copy of `hooks/<name>`,
    currently just `gate.mjs`) + one `.claude/skills/<name>/SKILL.md` per entry in
    `SKILLS` (`review-protocol`, `verify-change`, `write-a-packet`);
    tool `codex` → `AGENTS.md` + `.codex/config.toml` (file access) +
    `.codex/rules/artemis.rules` (commands), both from `permissions/codex.t<tier>.*`, and
    no `.claude/` surface or slash commands. Codex splits file and command policy across
    two files, so one Claude profile maps onto two Codex outputs.
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
  profile, each shipped slash command and hook byte-for-byte, and presence of
  `.github/ISSUE_TEMPLATE/task.yml`.
- `pnpm harness-lint` (`harness-lint.ts`) checks athena's own harness rather than a target
  repo — deterministic and offline, no agent and no network. Checks: every claim in
  `permissions/coherence.json` still holds (the layer states the command AND the named
  profiles cover that direct command prefix, or the claim is marked `advisory` with a
  reason); every flag-bearing
  deny rule carries a written acknowledgement (order-sensitive patterns are evadable —
  REVIEW-2026-07-15 #7); the worst-case compiled bundle stays under `BUNDLE_TOKEN_BUDGET`
  (3900, ratcheted to the measured worst case rather than invented; run harness-lint for the
  current estimate); and no rule line repeats inside one
  bundle. It also covers `hooks/`: the directory must match `HOOKS`, and every shipped hook
  must be referenced by all three permission profiles, since a hook no profile names is a
  dead script that reads like a gate. It also covers `commands/`: the directory must match `COMMANDS` exactly (an
  unlisted file never ships, a listed file that is absent makes compile throw), every command
  needs frontmatter carrying a description, no command repeats a line, and a same-named
  process doc at the repo root must reference `commands/<name>.md` — the mechanical version
  of conductor.md's "keep the two in step".
- **`ratchet.json` makes the quality numbers one-way.** `harness-lint` reads the LIVE value
  of each floor from the config that enforces it (`BUNDLE_TOKEN_BUDGET`, stryker's
  `thresholds.break`) and fails when it is looser than the tightest value ever recorded.
  Direction matters and is stored per floor: the bundle budget is a **ceiling**, so a higher
  number is the loosening; the mutation score is a **floor**, so a lower one is.
  - **Loosening is still possible, and that is deliberate.** A floor set on a lucky
    measurement sometimes has to come down. It needs an entry in `overrides` naming the
    exact value, with a date, a reason and an approver — so it arrives as a reviewed diff
    rather than a quiet config edit. The exact-value match is what stops one override
    becoming a standing exemption: move the number again and the old permission lapses.
  - `--write` clicks a floor **tighter only**. There is no flag that loosens one, because a
    command anyone can run is exactly the wrong shape for that decision.
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
- `pnpm test:mutation` — Stryker: rewrites the source a thousand ways and reports how many
  of those edits a test caught. ~50 s. Fails under `thresholds.break` in
  `stryker.config.json` (87; measured 88.86 on 2026-09-17). Treat the number as a ratchet:
  raise it when it rises, never lower it to turn a red build green. Survivors that no test
  can kill carry a `// Stryker disable next-line all` comment saying why.
- `pnpm acceptance <packet.md> <report.json>` — fails the build for any acceptance
  criterion with no passing test. Criteria carry ids (`- AC-1: ...`); a test claims one
  by writing `AC-1:` in its name. `pnpm test` writes `reports/tests.json` for it, and
  `check.ps1` runs it against the whole `packets/` directory. **Pass a directory and every
  packet in it is checked**; pass a file and only that one is, which is what platform's
  reusable workflow does after resolving the packet from the issue a PR closes. A directory
  matching nothing FAILs rather than passing vacuously. It used to name one file, so a second
  packet beside it was read by nothing — `packets/acceptance-gate.md` is still athena's own packet, kept
  as the worked example. Mechanises blocking finding 2 of `review-protocol.md`.
- Property tests live in `properties.test.ts` (fast-check), separate from the per-module
  test files because the seed is configured once there and the invariants span modules.
  **The seed is pinned** — a random one would move the mutation score between runs and
  make a failure unreproducible. Explore by raising `numRuns`, not by unpinning.
- `pnpm compile <dir>` / `pnpm doctor <dir>` — never point compile at a repo you don't
  intend to modify, and never at `../platform/templates/*` (it would dump rendered output
  into jinja sources).

## Map

- `compile.ts`, `doctor.ts` — the whole product. Tests live flat at root next to the code
  (`*.test.ts`); no `src/`, no `tests/`, no build (`tsx` runs TS directly).
- `instructions/` — the six canonical layers. `instructions.test.ts` auto-discovers `*.md`
  and enforces a **135-line cap per layer**. Valid `stack` values = existing
  `20-stack-*.md` files (ts, python); valid `targets` = `30-target-*.md` (workers,
  vscode-ext). Adding a file IS adding a valid config value.
- `permissions/` — Claude Code approval profiles: t0 reviewer, t1 author, t2 preview.
  **A repo picks one with `tier` in `.athena/config.json`** (0-2). Omitting it means tier 1,
  which is what every repo got before tiers existed, so adding the field drifts nothing.
  Adding a tier is adding its profile files, the same way adding a layer adds a valid stack.
  All three tiers ship both a Claude and a Codex profile. A tier missing either one fails
  loudly rather than installing another tier's permissions. Note that `codex.t2` is
  identical to `codex.t1.config.toml` on purpose — the t1/t2 difference is command-scoped,
  so it lives in `codex.t2.rules` instead. `permissions/README.md` has the mapping.
  General-purpose
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
- `hooks/` — node scripts compile installs verbatim into `.claude/hooks/` of every
  claude-enabled repo (`HOOKS`, compile.ts), referenced by the `hooks` block in every
  permission profile. Currently just `gate.mjs`, a `Stop` hook that runs the repo's own
  `lint` and `typecheck` and exits 2 while either is red, so an agent cannot end a turn on
  work the gate would reject. It is the only part of the harness that runs inside an
  agent's loop rather than in CI.
  - **Universal on purpose.** Each script calls the frozen package-script contract (D-18)
    and detects the toolchain at runtime, so one set of bytes serves pnpm and uv repos and
    doctor can compare them byte-exact. Nothing in a hook parses JSON, so no repo needs jq.
  - **Node, not shell, and not by shebang.** compile writes files without an exec bit and
    git does not preserve one on a Windows checkout, so the profile invokes an interpreter
    explicitly. That interpreter is `node` because on a Windows host `bash` resolves to
    WSL’s bash, which cannot read the Windows path Claude Code passes — a shell hook was
    verified to fail on exactly the machine the owner works from. node ships with Claude
    Code itself, so it is the one interpreter guaranteed to be there.
  - A red gate must not loop. `gate.mjs` returns 0 when Claude Code sets `stop_hook_active`,
    which is the second pass, so a permanently red repo stalls once and then reports.
  - harness-lint checks both halves: the directory matches `HOOKS`, and every shipped hook
    is referenced by all three profiles. A hook nobody references is a dead script that
    reads like a gate, which is worse than having no hook at all.
- `skills/<name>/SKILL.md` — procedure an agent loads **on demand**. Claude Code preloads
  each skill's `description` and fetches the body only when it decides the skill applies, so
  a skill is the opposite trade from an instruction layer: the layer is always in context and
  must stay short, the skill body is free until it is needed. Measured on `verify-change`:
  **91 always-on tokens across three skills against 1915 tokens of bodies.** The same
  content as instruction layers would have grown the bundle by half and blown the budget.
  - **The description is the mechanism, not a label.** It is the only part always loaded and
    the only thing routing sees, so harness-lint gates it: every skill needs one
    (`skillFrontmatterChecks`), their combined always-on cost has its own budget
    (`SKILL_DESCRIPTION_BUDGET`, 400, far tighter than the bundle), and no two may describe
    the same ground (`skillAmbiguityCheck`) — overlapping descriptions make routing a coin
    flip, so whichever loses may as well not ship.
  - The scorecard prices the two halves separately. One total would hide the ratio, which is
    the only number that says whether moving something into a skill was worth it.
  - Write the description by capability, not topic: what problem classes it handles, what it
    deliberately does not, in task language. `when_to_use` carries the triggers.
  - **A process doc and its skill are a pair.** `review-protocol.md` and `task-packet.md`
    keep the reasoning; `skills/review-protocol` and `skills/write-a-packet` carry what to
    do and ship to every repo. Nothing mechanically checks they stay in step: the names
    deliberately differ (`write-a-packet` routes better than `task-packet`), so the
    conductor cross-link trick does not apply, and a name check would not catch content
    drift anyway. Edit both. Known gap, not a solved one.
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
- Tool `codex` gets a profile but no commands. Its profile is weaker by Codex's design:
  it applies only once the human trusts the project, and Codex has no per-command deny
  list, so it carries t1's secret-file denials and not its command denials. See
  `permissions/README.md`.
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
