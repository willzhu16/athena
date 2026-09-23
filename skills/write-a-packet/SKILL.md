---
description: Scope a unit of agent work before it starts — write the goal, the non-goals, and acceptance criteria a test can claim by id.
when_to_use: Use when handing work to an agent, when filing a task issue, or when a packet you were given cannot be executed as written. Not for judging a finished diff, and not for deciding which gates to run.
---

# Writing a task packet

The packet is what makes agent output reviewable: review becomes diff-against-packet instead
of diff-against-vibes. **If you cannot fill every field, the work is not ready to delegate.**
Say so and go back to thinking rather than guessing at the gaps.

Small fixes may skip the packet. They never skip the gates.

## The fields

**Goal** — one sentence, an outcome rather than an activity. "Users can reset their password",
not "edit auth.ts".

**Non-goals** — files and behaviours the agent must not touch. **At least one entry.** An
empty non-goals field means the packet is not ready. This is the highest-value field in the
whole document, because it is the only one that bounds the work.

**Acceptance criteria** — observable statements, each with a stable id:

```
- AC-1: reports drift when .athena/project.md is edited without recompiling
```

**Constraints** — applicable decision records by id, plus performance and security notes the
code does not make obvious.

**Pointers** — paths and prior art. Never pasted file contents: the agent reads files itself,
and bulk-pasting context is what the instruction layers exist to avoid.

**Done means** — the default is every gate green and every criterion demonstrated. Add
anything project-specific.

## How a criterion becomes checkable

A test claims a criterion by putting its id followed by a colon in the test name:

```
it('AC-1: reports drift when the project layer changes', ...)
```

The colon separates a claim from a mention, so a test that merely discusses AC-10 covers
nothing. `acceptance` then fails the build for any criterion with no passing test, any test
claiming an id the packet dropped, any reused id, and any packet with no criteria at all.

A criterion that genuinely cannot be tested still needs saying out loud: write it **without
an id**, so the gate does not claim it is covered, and say in the PR how you checked it by
hand.
