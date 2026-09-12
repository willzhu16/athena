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
