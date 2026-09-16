import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * `athena acceptance`: checks that every acceptance criterion in a task packet is covered by
 * a passing test.
 *
 * `review-protocol.md` already calls "an acceptance criterion with no covering test" a
 * blocking finding — but the thing doing the finding is a human reading a diff, which is the
 * work this harness exists to remove. This makes that one rule mechanical.
 *
 * File-based on purpose, like harness-lint: it takes a packet and a test report as files and
 * knows nothing about GitHub, so it is deterministic, offline, and runnable in the same gate
 * as the unit tests. CI hands it the linked issue body; offline work hands it a packet
 * written in the repo, which `task-packet.md` already allows.
 */

export interface Finding {
  name: string;
  ok: boolean;
  detail: string;
}

export interface Criterion {
  id: string;
  text: string;
}

export interface TestOutcome {
  name: string;
  passed: boolean;
}

/**
 * A criterion line in a packet. Written as a list item, optionally a checkbox, then the id.
 * The separator may be a colon, a dash, an em dash or nothing, because a packet is prose a
 * person typed and rejecting it over punctuation would teach people to skip the tool.
 */
const CRITERION_LINE = /^\s*(?:[-*+]\s*)?(?:\[[ xX]?\]\s*)?(AC-\d+)\s*(?:[:.–—-]\s*)?(.*)$/;

/**
 * The criterion ids a test name *claims*, which is not the same as the ids it mentions. A
 * claim is written `AC-1:`; a name that merely refers to an id in prose ("AC-10 is not
 * evidence for AC-1") claims nothing. Dogfooding found this: without the colon, a test
 * explaining a criterion was read as covering it.
 */
const claimedIds = (text: string): string[] => text.match(/AC-\d+(?=:)/g) ?? [];

/**
 * Read the criteria out of a task packet. Accepts the whole packet, not just its acceptance
 * section, so the same file works whether it came from the issue form or was written inline.
 */
export const parseCriteria = (packet: string): Criterion[] => {
  const criteria: Criterion[] = [];
  for (const line of packet.split('\n')) {
    const match = line.match(CRITERION_LINE);
    if (match?.[1]) {
      criteria.push({ id: match[1], text: match[2].trim() });
    }
  }
  return criteria;
};

interface AssertionResult {
  fullName?: string;
  title?: string;
  status?: string;
}

interface TestReport {
  testResults?: { assertionResults?: AssertionResult[] }[];
}

/**
 * Flatten vitest's JSON reporter into name/passed pairs. `fullName` is used rather than
 * `title` so a criterion id may sit on the `describe` and cover every test inside it.
 */
export const parseTestReport = (json: string): TestOutcome[] => {
  const report = JSON.parse(json) as TestReport;
  const outcomes: TestOutcome[] = [];
  for (const file of report.testResults ?? []) {
    for (const assertion of file.assertionResults ?? []) {
      outcomes.push({
        name: assertion.fullName ?? assertion.title ?? '',
        passed: assertion.status === 'passed',
      });
    }
  }
  return outcomes;
};

/** One finding per criterion: covered by a passing test, or not. */
export const coverageChecks = (criteria: Criterion[], outcomes: TestOutcome[]): Finding[] =>
  criteria.map((criterion) => {
    const name = `${criterion.id} covered`;
    const naming = outcomes.filter((outcome) => claimedIds(outcome.name).includes(criterion.id));
    if (naming.length === 0) {
      return { name, ok: false, detail: `no test names ${criterion.id} — "${criterion.text}"` };
    }
    const passing = naming.filter((outcome) => outcome.passed);
    if (passing.length === 0) {
      // A criterion whose only tests fail is worse than one with no test: the packet reads
      // as covered while the behaviour it describes does not work.
      return {
        name,
        ok: false,
        detail: `${naming.length} test(s) name ${criterion.id}, none passed`,
      };
    }
    return { name, ok: true, detail: `${passing.length} passing test(s)` };
  });

/**
 * Criterion ids a test claims to cover that the packet does not list. This is what a renamed
 * or deleted criterion looks like from the test side, and it is the failure that would
 * otherwise leave a test asserting something nobody asked for.
 */
export const staleReferences = (criteria: Criterion[], outcomes: TestOutcome[]): string[] => {
  const known = new Set(criteria.map((criterion) => criterion.id));
  const stale = new Set<string>();
  for (const outcome of outcomes) {
    for (const id of claimedIds(outcome.name)) {
      if (!known.has(id)) {
        stale.add(id);
      }
    }
  }
  return [...stale].sort();
};

const packetChecks = (criteria: Criterion[]): Finding[] => {
  const findings: Finding[] = [];
  const counts = new Map<string, number>();
  for (const criterion of criteria) {
    counts.set(criterion.id, (counts.get(criterion.id) ?? 0) + 1);
  }
  const duplicates = [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id);
  findings.push({
    name: 'criterion ids are unique',
    ok: duplicates.length === 0,
    detail: duplicates.length === 0 ? 'no id used twice' : `reused: ${duplicates.join(', ')}`,
  });
  const untexted = criteria.filter((criterion) => criterion.text === '').map((c) => c.id);
  findings.push({
    name: 'criteria say something',
    ok: untexted.length === 0,
    detail: untexted.length === 0 ? 'every criterion has text' : `no text: ${untexted.join(', ')}`,
  });
  return findings;
};

/**
 * Check a packet against a test report. Returns one Finding per invariant, in the same shape
 * doctor and harness-lint use, so the three print and fail identically.
 */
export const acceptance = (packet: string, testReport: string): Finding[] => {
  const criteria = parseCriteria(packet);
  if (criteria.length === 0) {
    // A packet with no criteria is not a packet. Passing it silently would make the whole
    // check trivially green for exactly the work that most needs it.
    return [
      {
        name: 'packet',
        ok: false,
        detail: 'no acceptance criteria found — expected lines like "- AC-1: ..."',
      },
    ];
  }
  let outcomes: TestOutcome[];
  try {
    outcomes = parseTestReport(testReport);
  } catch (error) {
    return [{ name: 'test report', ok: false, detail: `unreadable: ${(error as Error).message}` }];
  }
  const findings: Finding[] = [
    { name: 'packet', ok: true, detail: `${criteria.length} criteria, ${outcomes.length} tests` },
    ...packetChecks(criteria),
    ...coverageChecks(criteria, outcomes),
  ];
  const stale = staleReferences(criteria, outcomes);
  findings.push({
    name: 'no stale criterion references',
    ok: stale.length === 0,
    detail:
      stale.length === 0
        ? 'every id a test names is in the packet'
        : `tests name ids the packet does not list: ${stale.join(', ')}`,
  });
  return findings;
};

/** The CLI's verdict. Exported so the rule that fails the run is reachable from a test. */
export const anyFailed = (findings: Finding[]): boolean => findings.some((finding) => !finding.ok);

export const main = (): void => {
  const [packetPath, reportPath] = process.argv.slice(2);
  if (!packetPath || !reportPath) {
    console.log('usage: athena acceptance <packet.md> <vitest-report.json>');
    process.exitCode = 1;
    return;
  }
  let findings: Finding[];
  try {
    findings = acceptance(readFileSync(packetPath, 'utf8'), readFileSync(reportPath, 'utf8'));
  } catch (error) {
    findings = [{ name: 'input', ok: false, detail: (error as Error).message }];
  }
  for (const finding of findings) {
    console.log(`${finding.ok ? 'PASS' : 'FAIL'}  ${finding.name} — ${finding.detail}`);
  }
  if (anyFailed(findings)) {
    process.exitCode = 1;
  }
};

// The CLI entry guard cannot be exercised from a test: the test runner is always
// argv[1], never this module. Excluded so the score measures testable logic.
// Stryker disable next-line all
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
