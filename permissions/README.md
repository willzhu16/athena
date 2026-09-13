# Permission profiles and their limits

Compile installs t1 for Claude; doctor compares it byte-for-byte. Codex receives no
permission file. t0 and t2 are available as source profiles but are not selected by compile.

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
never read. `harness-lint`'s `codex secret denials` check asserts the two profiles stay in
step on exactly that, and deliberately asserts nothing more — claiming the two formats are
equivalent would be the more dangerous error.

Schema verified against the Codex configuration reference on 2026-09-13: filesystem values
are `read` / `write` / `deny`, `deny` beats `write` beats `read`, and more specific entries
override broader ones.
