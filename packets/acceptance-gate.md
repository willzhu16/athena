# Task packet — make "criterion with no test" a check instead of a judgement

A worked example as much as a record: this is the packet for the acceptance gate itself,
written inline in the repo the way `task-packet.md` allows for offline work. It is what
`pnpm acceptance` is run against in `check.ps1`, so the tool is proved against real criteria
and real tests on every run rather than only against fixtures.

**Goal**
: An acceptance criterion with no covering test fails the build instead of waiting for a
  human to notice it while reading a diff.

**Non-goals**
: Do not change what `doctor` or `harness-lint` check. Do not introduce a BDD DSL or a
  Gherkin parser — criteria stay prose, and the link to a test is the criterion id in the
  test name. Do not make the tool talk to GitHub; it reads files. Do not require a repo to
  declare which test runner it uses: the report shape is detected, because a declaration in
  a second place is a declaration that can drift.

**Acceptance criteria**

- AC-1: a criterion that no test names is reported as uncovered, quoting the criterion so
  the gap is readable without opening the packet
- AC-2: a criterion whose only tests fail is reported as uncovered, because a packet that
  reads as covered while the behaviour is broken is worse than one with no test at all
- AC-3: a packet containing no criteria fails, rather than passing vacuously for exactly the
  work that most needs checking
- AC-4: a test naming a criterion the packet does not list is reported, so a renamed or
  deleted criterion cannot leave a test asserting something nobody asked for
- AC-5: the CLI exits non-zero when any criterion is uncovered, since the exit code is the
  gate and the printout is only how a human reads it
- AC-6: criterion ids are matched whole, so a test naming AC-10 is not evidence for AC-1
- AC-7: a pytest report is read as readily as a vitest one, so the gate is not a TypeScript
  privilege
- AC-8: a test claims a criterion in whatever spelling its language allows — `AC-1:` where
  punctuation is legal, `ac_1_` where the name must be an identifier
- AC-9: an id embedded in a longer word claims nothing, so `test_mac_10_thing` is not
  evidence for AC-10

**Constraints**
: Deterministic and offline, like `harness-lint` — no network, no agent, no API spend, so it
  can run in the same gate as the unit tests. Findings use the same `Finding[]` shape as
  `doctor` and `harness-lint` so all three print and fail identically.

**Pointers**
: `review-protocol.md` (blocking finding 2 is the rule this mechanises), `task-packet.md`,
  `harness-lint.ts` for the Finding shape and CLI pattern.

**Done means**
: All checks in spec 01/02 green, and `pnpm acceptance packets/acceptance-gate.md <report>`
  passes against athena's own test report.
