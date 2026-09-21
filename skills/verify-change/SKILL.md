---
description: Run this repo's gates in the cheapest-first order and read what each one actually proves, before claiming a change is done.
when_to_use: Use when about to say a change is finished, when a gate has gone red and it is unclear which one to run next, or when deciding whether a change needs the slow gates at all. Not for interpreting a specific failing assertion — read the failure output for that.
---

# Verifying a change

Gates are ordered by what they cost, not by what they prove. Run the cheap ones first so a
typo never costs a mutation run.

| Order | Command | What it answers |
|---|---|---|
| 1 | `lint` | Does this match the conventions the linter owns? |
| 2 | `typecheck` | Do the types hold together? |
| 3 | `test` | Does the behaviour the tests describe still happen? |
| 4 | `test:mutation` | **Would a test have noticed if the code were wrong?** |
| 5 | `build` | Does it bundle and would it deploy? |

A pnpm repo runs these as `pnpm <name>`; a uv repo as `uv run ruff check .`,
`uv run pyright`, `uv run pytest --cov`, `uv run python scripts/mutation.py`. The names are
a frozen contract, so the first three exist in every repo athena manages.

## What each gate does not prove

- **A green test run says the tests pass, not that the feature works.** For anything
  user-visible, exercise it for real and put the evidence in the PR — command output, a
  curl transcript, a screenshot.
- **Coverage says a line ran.** It does not say an assertion would have caught a change to
  it. That is what the mutation gate is for, and why its floor is a ratchet.
- **A passing gate on your machine is not CI.** Reusable workflows resolve on GitHub, and
  some jobs (template renders, security scans) have no local equivalent at all.

## The two that are easy to forget

- **The regression rule.** Every bug fix needs a test that fails *before* the fix. If it
  passed before your change, it is not covering your change. Make it fail once on purpose.
- **The acceptance gate.** If the work has a task packet, every criterion needs a test
  claiming its id (`AC-1:` in the test name). `acceptance` fails the build for any criterion
  with no passing test, so a reviewer should never be the first to notice a gap.

## When a gate is red twice

Stop. Two failures on the same fix mean the mental model is wrong, not that the third
variation will land it. Say what you tried and what you expected, and ask. This is the
anti-loop rule, and it is the one that saves the most time when honoured early.

## The gate runs itself at turn end

`.claude/hooks/gate.mjs` runs lint and typecheck when a turn ends and blocks the turn while
either is red. It is a backstop, not a substitute: it does not run the tests, the mutation
gate or the build, and a tool without hook support gets no backstop at all.
