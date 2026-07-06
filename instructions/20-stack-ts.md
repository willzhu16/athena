# TypeScript conventions

Toolchain (D-19): pnpm · Biome (lint + format) · Vitest · `tsc --noEmit` · Node current
LTS. Library builds use tsup/esbuild; Workers use wrangler's bundler.

Biome already enforces the mechanical rules — single quotes, semicolons, spaces, import
order. **Do not restate or hand-fix what the linter owns.** This layer states only what a
linter cannot check.

## What the linter can't check

- **Names carry meaning.** Descriptive names; no single-letter identifiers except loop
  indices; no abbreviations unless industry-standard (URL, API, ID). A good name removes
  the need for a comment.
- **Small functions.** Keep functions under ~40 lines. When one grows past that, extract
  named helpers — the extraction usually reveals the real shape of the problem.
- **Named exports only, never default.** Named exports make refactors and find-all-refs
  reliable; default exports rename silently and hide from tooling.
- **`const` by default.** Reach for `let` only when you truly reassign; never `var`.
- **Types are contracts, not decoration.** Prefer precise types over `any`; if you reach
  for `any`, leave a comment saying why. `unknown` + narrowing beats `any` almost always.

## Testing

- Vitest. Every new behaviour gets a test; every bug fix gets a regression test that fails
  before the fix.
- Prefer real implementations over mocks — mock only when there is no alternative.
- One observable behaviour per test; no mega-tests piling up ten unrelated assertions.
- Tests must not depend on network, wall-clock time, or filesystem state outside the repo.

## Errors

- Throw `Error` instances carrying a message a human can act on; include the failing
  identifier where it helps.
- Catch at system boundaries (route handlers, IO), not in every helper along the way.
- Never swallow an error without a comment explaining why ignoring it is safe.
