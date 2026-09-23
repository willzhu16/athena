# Task packet

The contract that makes agent output reviewable: review is *diff vs packet*, not diff vs
vibes. No non-trivial agent work starts without one. Instantiate it as a GitHub issue via
`.github/ISSUE_TEMPLATE/task.yml`, or inline in the repo for offline work. Small fixes may
skip the packet — they never skip the gates.

This file is the process document. The operational half ships to every claude-enabled repo as
`skills/write-a-packet/SKILL.md`, loaded on demand when someone is actually scoping work —
until then a generated repo could reach this format only through the issue template. **Keep
the two in step:** this one carries the reasoning, the skill carries what to write.

If you cannot fill every field, the work is not ready to delegate: go back to thinking.

---

**Goal**
: One sentence, outcome not activity. ("Users can reset their password", not "edit auth.ts".)

**Non-goals**
: Files and behaviours the agent must NOT touch. At least one entry — an empty non-goals
  field means the packet is not ready. This is the highest-value field for bounding an agent.

**Acceptance criteria**
: Observable, checkable statements, **each given a stable id**: `- AC-1: ...`. A test claims
  a criterion by writing that id followed by a colon in its name, on the `it` or on a
  `describe` around several:

      it('AC-1: reports drift when .athena/project.md is edited without recompiling', ...)

  The colon is what separates a claim from a mention, so a test that merely discusses AC-10
  is not counted as covering it. `pnpm acceptance <packet> <test-report>` then fails the
  build for any criterion with no passing test, any test claiming an id the packet dropped,
  any reused id, and any packet with no criteria at all. `packets/acceptance-gate.md` is a
  worked example. "Done" is no longer demonstrated one by one by a person — it is checked.

  A criterion that genuinely cannot be tested (a manual check) still needs saying out loud:
  write it without an id so the gate does not claim it is covered, and say in the PR how it
  was verified.

**Constraints**
: Applicable ADRs / DECISIONS entries by ID; performance and security notes; anything the
  agent must honour but that is not obvious from the code.

**Pointers**
: Paths, docs, and prior-art links — never pasted file contents. The agent reads files
  itself; bulk-pasting context is what these layers exist to avoid.

**Done means**
: "All checks in spec 01/02 are green and every acceptance criterion is demonstrated"
  (default) — and `acceptance / acceptance` is green, which is that second half made
  mechanical. Add anything project-specific.

---

Branch: `agent/<tool>/<task-slug>`. PR title carries the packet number: `feat: … (#42)`.
The PR description ends with the session log (see `review-protocol.md`).
