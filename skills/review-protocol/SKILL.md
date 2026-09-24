---
description: Judge a finished change — decide what blocks a merge, what is only advice, and when to stop arguing and escalate.
when_to_use: Use when reviewing someone else's diff, when deciding whether your own change may be called done, or when a review round has gone back and forth and it is unclear whether to push again. Not for scoping work that has not started, and not for running the gates.
---

# Reviewing a change

Review is **diff against the packet**, not diff against taste. If the packet did not ask for
it and the change is not wrong, it is not a review finding.

## Before an author may claim done

1. Lint, typecheck and tests green, including **one new test that fails without the change**.
2. gitleaks and semgrep clean.
3. For anything user-visible, **evidence of running it for real** in the PR — command output,
   a transcript, a screenshot. Green tests prove the tests pass, not that the feature works.

## What blocks a merge

Only three things:

1. **A new dependency nobody acknowledged.** This is the anti-slopsquatting control, so it is
   blocking even when the package is obviously fine.
2. **An acceptance criterion with no covering test.** This one is mechanical now — the
   `acceptance` gate fails the build for it. A reviewer finding it by eye means the gate did
   not run, or the criterion has no id.
3. **A demonstrated correctness or security defect** the change introduced or exposed. Cite
   `file:line` and a concrete failure scenario. A speculative concern is not a blocker.

Everything else is advisory. Style belongs to the linter, which already ran. "Could be
cleaner" is not a finding. The author may decline an advisory point with one sentence of
reasoning, and the human sees both sides at merge time.

An author may **not** downgrade a demonstrated defect to advisory just because the packet did
not mention it. If fixing it would exceed scope, stop and ask rather than shipping it.

## When to stop

The universal anti-loop rules are always in context and are deliberately not repeated here:
a fix that fails its gate twice means stop, and settled decisions are not reopened. Review
adds one limit of its own.

- **Two review rounds per PR.** Round three is a human decision, not another lap.

A finding without `file:line` and a concrete failure scenario is invalid. That rule exists
because an unfalsifiable comment costs a round trip and settles nothing.
