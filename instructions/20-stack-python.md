# Python conventions

Toolchain (D-21): uv (packaging + lockfile) · Ruff (lint + format) · pyright (typecheck,
strict) · pytest (with coverage). Lockfile-first: `uv.lock` is committed and installs use
`uv sync --frozen`.

Ruff already enforces the mechanical rules (formatting, import order, common lints).
**Do not restate or hand-fix what Ruff owns.** This layer states only what a linter can't.

## What the linter can't check

- **Names carry meaning.** Descriptive `snake_case`; no single-letter names except loop
  indices; no abbreviations unless industry-standard. A good name removes a comment.
- **Small functions.** Keep functions under ~40 lines; extract named helpers when one
  grows past that.
- **Type everything at the boundaries.** Annotate public function signatures; prefer
  precise types over `Any`. pyright runs strict — a passing typecheck is part of done.
- **Prefer the standard library** for anything under ~50 lines before adding a dependency
  (this is also the anti-slopsquatting default, 10-security).
- **Explicit over clever.** No wildcard imports; no mutable default arguments; guard
  clauses over deep nesting.

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
