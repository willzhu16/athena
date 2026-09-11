---
description: Split a spec into task packets and dispatch up to three agents in parallel
argument-hint: <spec path, or a description of the work>
---

Act as the conductor for: $ARGUMENTS

This is the pre-Foreman dispatch pattern (D-28). You change *dispatch*, never the rules:
every worker follows this repo's compiled instructions and every gate still runs.

## 1. Decompose

Read the spec and split it into task packets, each with Goal, Non-goals, Acceptance
criteria, Constraints and Pointers. State an explicit dependency order. Flag any packets
that touch overlapping files so they are serialized rather than run side by side.

## 2. Stop and get the split approved

Start no work until the human approves the decomposition. This is the highest-leverage
review point in the run and it costs minutes. A bad split caught here saves hours of work
in the wrong direction.

## 3. Dispatch, at most three at a time

Spawn worker subagents in isolated git worktrees, only for packets whose dependencies are
met. Three concurrent is a hard cap: it is the human's review budget, not a technical
limit. Raising it is a decision-record amendment, never a judgement call made mid-run.

## 4. Let workers be ordinary agents

Each worker gets its own branch (`agent/<tool>/<task-slug>`), runs every gate, and opens a
pull request ending in a session log. Workers inherit the same compiled instructions you
are reading now.

## 5. Summarise, then stop

Post one comment linking every pull request in review order, then stop. You never merge.
You never let your own read of a worker's output substitute for the review protocol. You
never respawn a failed worker more than once: two failures of the same gate mean the
mental model is wrong, not that it was unlucky.
