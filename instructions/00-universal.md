# Universal working rules

Applies to every repo and every tool. This is the canonical source — it is compiled into
CLAUDE.md / AGENTS.md, never read directly. Keep it short; link to the handbook rather
than restating it.

## Scope discipline

- Do exactly what the task packet asks — no more. The packet's **Non-goals** are binding:
  do not touch files or behaviours listed there.
- If the task is not fully described by the packet, stop and ask. A packet you cannot
  execute as written is not ready; say so instead of guessing.
- Minimal diffs. No drive-by refactors, no abstractions for hypothetical futures, no
  cleanup nobody asked for. Notice it, mention it, move on.

## Verify, don't assume

- Read a file before editing it. Any fact about the codebase you have not seen with your
  own tools this session is an assumption — check it before relying on it.
- Match the surrounding code: naming, file placement, error handling, style. New code
  should read like the same author wrote it. Never import conventions from other projects.

## Definition of done

Done means every item in the handbook definition-of-done, in particular:

- All CI gates green: lint, typecheck, tests (spec 01), gitleaks, semgrep, osv (spec 02).
- A new test that **fails without your change** covers the behaviour (regression rule).
- Behaviour verified by actually running it — green tests prove the tests pass, not that
  the feature works. Include the evidence (command output, transcript) in the PR.
- Docs updated in the same PR (README / runbooks / ADR as applicable); no debug logging,
  commented-out code, or stray TODOs left in the diff.

See `platform/handbook/definition-of-done.md`.

## Honesty

- Report failures plainly. Never claim something works that you have not run.
- Ground every progress claim in a tool result from this session. If a step was skipped
  or a test failed, say so — with the output.
- "It compiles" is not verification. "Done" without having run something is not done.

## Commits and attribution

- Conventional Commits, imperative mood ("Add parser", not "Added parser"). The `commits`
  gate enforces the format.
- Work on a branch named `agent/<tool>/<task-slug>`; put the packet number in the PR title
  (`feat: … (#42)`). End the PR body with the session log (see 00 §Session log).

## Anti-loop (binding; full protocol in review-protocol.md)

- A fix that fails its gate **twice in a row** = stop, summarise the disagreement, ask.
  Do not try a third variation — two failures mean the mental model is wrong.
- Max two AI review rounds per PR; round three is a human decision.
- Do not re-litigate settled decisions (DECISIONS.md, in-repo ADRs) or the packet's
  non-goals. Disagreement becomes an issue, not a review comment or a silent workaround.

## Session log

Every meaningful agent session ends by appending this block to the PR description — it is
the audit trail and the input to improving these layers:

```
## Session log
Tool/model: … | Packet: #NN
Tried: … | Dead ends: … | Decisions made and why: …
```
