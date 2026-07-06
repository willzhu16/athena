# Task packet

The contract that makes agent output reviewable: review is *diff vs packet*, not diff vs
vibes. No non-trivial agent work starts without one. Instantiate it as a GitHub issue via
`.github/ISSUE_TEMPLATE/task.yml`, or inline in the repo for offline work. Small fixes may
skip the packet — they never skip the gates.

If you cannot fill every field, the work is not ready to delegate: go back to thinking.

---

**Goal**
: One sentence, outcome not activity. ("Users can reset their password", not "edit auth.ts".)

**Non-goals**
: Files and behaviours the agent must NOT touch. At least one entry — an empty non-goals
  field means the packet is not ready. This is the highest-value field for bounding an agent.

**Acceptance criteria**
: Observable, checkable statements. Each maps to a test where possible, or a documented
  manual check. "Done" is demonstrated against these, one by one.

**Constraints**
: Applicable ADRs / DECISIONS entries by ID; performance and security notes; anything the
  agent must honour but that is not obvious from the code.

**Pointers**
: Paths, docs, and prior-art links — never pasted file contents. The agent reads files
  itself; bulk-pasting context is what these layers exist to avoid.

**Done means**
: "All checks in spec 01/02 are green and every acceptance criterion is demonstrated"
  (default). Add anything project-specific.

---

Branch: `agent/<tool>/<task-slug>`. PR title carries the packet number: `feat: … (#42)`.
The PR description ends with the session log (see `review-protocol.md`).
