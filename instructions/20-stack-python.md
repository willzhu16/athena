# Python conventions

Toolchain (D-21): uv (packaging + lockfile) · Ruff (lint + format) · pyright (typecheck,
strict) · pytest (with coverage). Lockfile-first: `uv.lock` is committed and installs use
`uv sync --frozen`.

Ruff enforces the mechanical rules, and that now includes three this layer used to only ask
for: `snake_case` naming (`N`), annotated signatures and precise types over `Any` (`ANN`,
relaxed in `tests/`), and functions under 40 statements (`PLR0915`). **Do not restate or
hand-fix what Ruff owns** — when it is red, read the rule code rather than guessing.

## What the linter still cannot check

- **A name has to mean something.** Ruff checks the case convention, not the word. `data`,
  `tmp` and `do_it` all pass it and all tell the next reader nothing.
- **Prefer the standard library** for anything under ~50 lines before adding a dependency
  (this is also the anti-slopsquatting default, 10-security).
- **Explicit over clever.** Ruff catches wildcard imports and mutable defaults. It does not
  catch a short function that is simply hard to follow, so prefer guard clauses to nesting.

## Testing

- pytest. Every new behaviour gets a test; every bug fix gets a regression test that fails
  before the fix.
- Prefer real implementations over mocks — mock only when there is no alternative.
- One observable behaviour per test.
- Tests must not depend on network, wall-clock time, or filesystem state outside the repo.

## Errors

- Raise specific exceptions with actionable messages; include the failing input where it
  helps.
- Catch at boundaries, not in every helper. Never swallow an exception without a comment
  explaining why it is safe.
