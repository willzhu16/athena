# Conductor mode

The pre-Foreman pattern (D-28): "put a spec out, several agents each take a task" — with
**zero new runtime**, using Claude Code's built-in subagents and git worktrees. This file
is the human-readable protocol; `commands/conductor.md` is the operational version that
compile installs into every claude-enabled repo as `.claude/commands/conductor.md`, so the
pattern is reachable as `/conductor` rather than only readable here. Keep the two in step.
Conductor mode changes *dispatch*, never the rules: every worker follows standard T1 rules
and every gate still runs.

## Protocol

1. **Decompose.** The conductor session reads a design spec and breaks it into task packets
   (`task-packet.md` format, filed as issues) with an explicit dependency order. Packets
   that touch overlapping files are flagged to serialize.
2. **Human approves the plan.** No work starts until the human approves the packet
   decomposition. This is the highest-leverage review point and it is cheap (minutes) —
   catching a bad split here saves hours of wrong work.
3. **Dispatch, max 3 concurrent.** The conductor spawns worker subagents in isolated git
   worktrees for packets whose dependencies are met. The cap of **3** is the review-budget
   guardrail (D-25 reasoning); raising it is a D-28 amendment, not a config tweak.
4. **Workers are ordinary T1 agents.** Each gets its own branch, runs every gate, and opens
   a PR with a session log. Workers inherit the same compiled instructions.
5. **Conductor summarises and stops.** It posts one comment linking every PR in review
   order, then stops. The conductor **never merges, never reviews its own workers' output
   as a substitute for the review protocol, and never respawns a failed worker more than
   once** (anti-loop rule 5 applies across workers).

## Boundaries

- Cross-tool workers (a Codex worker beside Claude workers) are **manual today** — run the
  packet in the other tool yourself. Automating heterogeneous dispatch is Foreman by
  definition (D-17): log the desire in `FOREMAN-NOTES.md` when felt, do not build it here.
- The conductor holds no state beyond git and the issue tracker. The moment this pattern
  wants a queue, a daemon, or a dashboard, it has become a Foreman feature request.
