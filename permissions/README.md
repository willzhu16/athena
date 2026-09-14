# Permission profiles and their limits

Compile installs the profile a repo's `tier` names (0-2, default 1) and doctor compares it
byte-for-byte. t0 is a read-only reviewer, t1 the standard author agent, t2 t1 plus preview
deploys. Only t1 currently ships a Codex counterpart, so `tier: 0` or `tier: 2` together
with tool `codex` is a compile error rather than a silent fall back to t1's permissions.

The profiles deny named direct commands and direct reads of `.env`, `.env.*`, and
`secrets/**`. t1/t2 automatically approve named development commands and frozen installs,
but no longer approve arbitrary pnpm/npm/npx/uv/uvx/node/python invocations. Other
invocations follow the tool's active permission mode; in normal manual mode they need
approval. Arguments added to an exact allowed command also need approval.

These are approval defaults, **not sandboxes**. Approved project scripts, test runners,
git hooks, and installed packages can execute subprocesses. A direct-command deny does
not cover every wrapper, alternate executable path, or reordered flag. The force-push
patterns remain order-sensitive; the acknowledgements in coherence.json record that
limitation, not a successful security test. t0 denies file-edit tools, but its allowed
check scripts can still write files.

Keep production credentials and decryption keys out of agent environments. Enforce
filesystem/network boundaries with a sandbox or isolated environment, and enforce
protected-branch policy on the server. This repo does not provision those local isolation
controls. Do not represent a green harness-lint result as proof that isolation exists.

`coherence.json` declares direct command families. The linter accepts a deny covering the
same or a broader prefix with a command boundary, and rejects narrower subcommands,
exact-only rules, empty claims, and missing enforcement tiers. Complex glob equivalence
is deliberately not inferred. An advisory claim must explain why it is advisory.

Reference, checked 2026-09-11:
- [Claude permission matching and limitations](https://code.claude.com/docs/en/permissions#what-a-bash-rule-doesnt-match)
- [Claude sandboxing](https://code.claude.com/docs/en/sandboxing)

After a profile change, recompile managed projects and review their sync PRs. Existing
repos retain their previous profile until the updated output is installed.

## The Codex profile

`codex.config.toml` is installed at `.codex/config.toml` for any repo whose config lists
tool `codex`, and doctor checks it byte-for-byte like the Claude profile. It is genuinely
weaker, in two ways that are properties of Codex rather than defects to fix.

**It applies only once the human trusts the project.** Codex "loads project-scoped config
files only when the project is trusted. If the project is untrusted, Codex ignores project
`.codex/` layers." A repo cannot restrict — or widen — itself unilaterally. An
admin-managed `requirements.toml` further bounds what a project may even request.

**Codex has no per-command deny list.** There is no equivalent of `Bash(wrangler deploy:*)`.
Command-level control comes from the sandbox and the approval prompt instead. So the command
half of t1 has no analog here, and the controls that actually stop a deploy are the ones
that always did: production credentials are absent from the agent's environment, and the
branch ruleset and tag-gated environment live on GitHub.

What does carry across is the half both schemas can express: the secret files an agent must
never read. `harness-lint` asserts that for every tier, and deliberately asserts nothing
more — claiming the two formats are equivalent would be the more dangerous error.

### Tiers on the Codex side

Codex splits what Claude keeps in one file. `.claude/settings.json` holds both file access
and command policy; Codex uses `.codex/config.toml` for file access and a separate Starlark
rules file for commands. So each tier ships **two** Codex files:

| Tier | File access | Commands |
|---|---|---|
| t0 | `codex.t0.config.toml` | `codex.t0.rules` |
| t1 | `codex.t1.config.toml` | `codex.t1.rules` |
| t2 | `codex.t2.config.toml` | `codex.t2.rules` |

compile installs them at `.codex/config.toml` and `.codex/rules/artemis.rules`, and
harness-lint fails a tier that ships one half without the other — half a profile enforces
half of what the tier promises. The rules file is named `artemis.rules` in the target so it
cannot collide with a rules file the repo's owner writes.

**t0 maps cleanly.** "Read but never write" is native to Codex via the built-in `:read-only`
set. The command rules add what the sandbox alone misses: `git commit` and `rm` do not go
through the agent's file tools, so read-only file access does not stop them.

**t1 and t2 differ in the rules file, not the config.** Their file access is identical; the
whole difference is that `wrangler versions upload` and `wrangler pages deploy` stop being
forbidden at t2, while `wrangler versions deploy` — the production promotion — stays
forbidden. That is expressed by *narrowing* the forbidden rule rather than adding an allow
beside it, because the most restrictive matching rule wins: an `allow` for
`wrangler versions upload` sitting next to a `forbidden` for `wrangler versions` would lose.

### What the rules format gives us that the Claude format does not

`match` and `not_match` are inline unit tests, and Codex **refuses to load a rules file**
whose `match` example fails to match. A rule cannot silently stop working — which is exactly
how the semgrep pack and the ntfy rule each rotted before anyone noticed.

That also lets the known gaps be written down and tested. Prefix matching has the same hole
in both tools:

```
git push --force              -> forbidden
git push origin main --force  -> not matched
```

The tier 1 rules record that second spelling in `not_match`, so the limitation is explicit
rather than discovered, and if it ever stops being true the file fails to load and forces
the note to be updated. Validate any change with:

```
codex execpolicy check --pretty --rules permissions/codex.t1.rules -- <command>
```

Schema verified against the Codex rules and configuration references on 2026-09-14, and
every rules file in this directory was checked with that command.
