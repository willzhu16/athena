# Review protocol

Normative for the AI review pass (spec 10) and usable manually today. The human is always
the last gate; this protocol governs what happens before that final read.

## When an author-agent may claim "done"

Only when local gates are green:

1. typecheck, lint, tests — including **one new test that fails without the change**
   (regression rule).
2. gitleaks, semgrep clean.
3. For behaviour-affecting changes: **evidence of exercising the change for real** in the
   PR (command output, curl transcript, screenshot). Green tests prove the tests pass, not
   that the feature works.

## The review (fresh session, different model when convenient)

The reviewer reads the **diff against the task packet** — not the whole repo, not against
its own taste.

**Blocking findings:**

1. A new dependency introduced without human acknowledgment.
2. An acceptance criterion with no covering test. **This one is now mechanical**:
   `pnpm acceptance` fails the build for it, so a reviewer should never be the first
   thing to notice it. Criteria carry ids and tests claim them by name — see
   `task-packet.md`. A reviewer finding this by eye means the gate was not run or the
   criterion has no id.
3. Demonstrated correctness or security defects introduced or exposed by the change,
   including regressions, data loss, or violations of the packet's constraints. Cite a
   concrete failure scenario and evidence; a speculative concern is not a blocker.

**Style and speculative improvements are advisory.** A finding must cite `file:line`
and a concrete failure scenario. "Could be cleaner" is not a finding — style belongs to the linter, which already
ran. The author-agent may `wontfix` an advisory finding with one sentence of reasoning; the
human sees both sides at merge time.

An author may not dismiss a demonstrated defect as advisory just because an acceptance
criterion omitted it. If resolving it would exceed scope, stop and ask the human to
decide; the human remains the final merge gate.

## Anti-loop rules (binding on all agents)

1. **Max two review rounds** per PR. Round three = stop, summarise the disagreement, human
   decides.
2. A review finding cites `file:line` + a concrete failure scenario, or it is invalid.
3. **No re-litigating** settled decisions (DECISIONS.md, in-repo ADRs) or the packet's
   non-goals. A reviewer who disagrees with the architecture files an issue, not a comment.
4. The author-agent may `wontfix` an advisory finding with one sentence; it is not silently
   dropped.
5. **A fix that fails its gate twice in a row = stop and report, do not thrash.** This is the
   single most important rule for token- and sanity-economics.
6. Settled decisions and packet non-goals are not reviewable; disagreement becomes a new
   issue.

## Session log (last block of every agent PR description)

```
## Session log
Tool/model: <tool>/<model>
Packet: #<issue>, or none
Plan: before-first-edit | mid-task | none
Gates: <the gates you actually ran>
Retries: <N> gate failures before green
Abstained: no, or yes — <what you stopped and asked about>
Tried: <the approach that worked, in one line>
Dead ends: <what was attempted and abandoned, and why — this is the valuable part>
Decisions and why: <choices not spelled out in the packet, with the reason>
```

This is the audit trail (ARCHITECTURE §6.6) and the input to improving the instruction
layers: recurring mistakes become new lint/CI rules (preferred) or instruction lines
(fallback) at the monthly session-log harvest (spec 05 cadence).

The first six fields are enumerated so the harvest can tally them instead of reading every
PR by hand, which is why it kept not happening. `Plan`, `Retries` and `Abstained` are the
three a reviewer cannot reconstruct from the diff: whether a plan preceded the first edit,
how many times a gate went red, and whether the agent stopped and asked rather than guessed.
Platform's `scripts/session-log.sh` validates a block and rejects an unfilled `<placeholder>`;
the [template](https://github.com/willzhu16/platform/blob/v1/handbook/templates/session-log.md)
carries a worked example that platform's own CI checks.
