import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  acceptance,
  anyFailed,
  type Criterion,
  coverageChecks,
  main,
  parseCriteria,
  parseTestReport,
  staleReferences,
  type TestOutcome,
} from './acceptance.ts';

/** A vitest JSON report carrying the given test names and outcomes. */
const report = (tests: [string, 'passed' | 'failed' | 'skipped'][]): string =>
  JSON.stringify({
    testResults: [
      {
        assertionResults: tests.map(([fullName, status]) => ({ fullName, status })),
      },
    ],
  });

describe('reading criteria out of a packet', () => {
  it('accepts the shapes a person actually types', () => {
    // A packet is prose someone wrote in an issue form. Rejecting it over a dash versus a
    // colon would just teach people to skip the tool.
    const criteria = parseCriteria(
      [
        '## Acceptance criteria',
        '- AC-1: doctor reports drift for an edited project layer',
        '- [ ] AC-2 — a missing permission profile fails',
        '* [x] AC-3. the exit code is non-zero when any check fails',
        'AC-4: no list marker at all',
        'AC-99 and a sentence that merely mentions it, in prose.',
      ].join('\n'),
    );

    expect(criteria.map((criterion) => criterion.id)).toEqual([
      'AC-1',
      'AC-2',
      'AC-3',
      'AC-4',
      'AC-99',
    ]);
    expect(criteria[0]?.text).toBe('doctor reports drift for an edited project layer');
    expect(criteria[1]?.text).toBe('a missing permission profile fails');
    expect(criteria[2]?.text).toBe('the exit code is non-zero when any check fails');
  });

  it('finds nothing in a packet that has no criteria', () => {
    expect(parseCriteria('## Goal\n\nMake it faster.\n')).toEqual([]);
  });
});

describe('reading the test report', () => {
  it('uses the full name, so an id on the describe covers the tests inside it', () => {
    const outcomes = parseTestReport(
      JSON.stringify({
        testResults: [
          {
            assertionResults: [
              { title: 'inner', fullName: 'AC-1: drift detection inner', status: 'passed' },
            ],
          },
        ],
      }),
    );

    expect(outcomes).toEqual([{ name: 'AC-1: drift detection inner', passed: true }]);
  });

  it('counts only passed as passed, so a skipped test is not evidence', () => {
    expect(parseTestReport(report([['AC-1: a', 'skipped']]))[0]?.passed).toBe(false);
  });

  it('survives a report with no results at all', () => {
    expect(parseTestReport('{}')).toEqual([]);
  });

  it('reads a file entry that reported no assertions as zero tests', () => {
    // A suite that failed to load still lands in the report, with no assertionResults at
    // all. Reading it as zero tests keeps the gate running instead of crashing the check.
    expect(parseTestReport(JSON.stringify({ testResults: [{}] }))).toEqual([]);
  });

  it('falls back to the title when the reporter emitted no full name', () => {
    // Without the fallback the name is empty, the test matches no criterion, and a packet
    // that is genuinely covered reports as uncovered.
    const outcomes = parseTestReport(
      JSON.stringify({
        testResults: [{ assertionResults: [{ title: 'reports drift', status: 'passed' }] }],
      }),
    );

    expect(outcomes).toEqual([{ name: 'reports drift', passed: true }]);
  });

  it('keeps a nameless assertion, so the reported test count stays honest', () => {
    // The count is how a reviewer sees the report was read at all. An empty name claims no
    // criterion, so keeping the entry cannot make an uncovered packet look covered.
    const outcomes = parseTestReport(
      JSON.stringify({ testResults: [{ assertionResults: [{ status: 'passed' }] }] }),
    );

    expect(outcomes).toEqual([{ name: '', passed: true }]);
  });
});

describe('criterion coverage', () => {
  const criteria: Criterion[] = [{ id: 'AC-1', text: 'the thing happens' }];

  it('passes a criterion a passing test names', () => {
    const finding = coverageChecks(criteria, [
      { name: 'AC-1: the thing happens', passed: true },
    ])[0];

    expect(finding?.ok).toBe(true);
    expect(finding?.detail).toBe('1 passing test(s)');
  });

  it('AC-1: fails a criterion no test names, and quotes it so the gap is readable', () => {
    const finding = coverageChecks(criteria, [{ name: 'something else', passed: true }])[0];

    expect(finding?.ok).toBe(false);
    expect(finding?.detail).toBe('no test names AC-1 — "the thing happens"');
  });

  it('AC-2: fails a criterion whose only tests fail', () => {
    // Worse than no test: the packet reads as covered while the behaviour does not work.
    const finding = coverageChecks(criteria, [{ name: 'AC-1: the thing', passed: false }])[0];

    expect(finding?.ok).toBe(false);
    expect(finding?.detail).toBe('1 test(s) name AC-1, none passed');
  });

  it('passes when at least one of several tests passes', () => {
    const outcomes: TestOutcome[] = [
      { name: 'AC-1: first', passed: false },
      { name: 'AC-1: second', passed: true },
    ];

    expect(coverageChecks(criteria, outcomes)[0]?.ok).toBe(true);
  });

  it('AC-6: matches ids whole, so AC-10 is not evidence for AC-1', () => {
    // Substring matching would make every AC-1x test count as evidence for AC-1.
    const finding = coverageChecks(criteria, [{ name: 'AC-10: other thing', passed: true }])[0];

    expect(finding?.ok).toBe(false);
  });
});

describe('stale references', () => {
  it('names ids the tests claim that the packet does not list', () => {
    const criteria: Criterion[] = [{ id: 'AC-1', text: 'x' }];
    const outcomes: TestOutcome[] = [
      { name: 'AC-1: fine', passed: true },
      { name: 'AC-7: renamed away', passed: true },
      { name: 'AC-9: also gone', passed: true },
    ];

    expect(staleReferences(criteria, outcomes)).toEqual(['AC-7', 'AC-9']);
  });

  it('ignores an id a test only mentions in prose', () => {
    // Regression: found by running this gate against its own packet. A test explaining why
    // AC-10 is not evidence for AC-1 was read as claiming both. A claim needs the colon.
    const criteria: Criterion[] = [{ id: 'AC-1', text: 'x' }];
    const outcomes: TestOutcome[] = [{ name: 'AC-1: real claim, unlike AC-42 here', passed: true }];

    expect(staleReferences(criteria, outcomes)).toEqual([]);
    expect(coverageChecks(criteria, outcomes)[0]?.ok).toBe(true);
  });

  it('is empty when every referenced id is in the packet', () => {
    expect(
      staleReferences([{ id: 'AC-1', text: 'x' }], [{ name: 'AC-1: x', passed: true }]),
    ).toEqual([]);
  });
});

describe('acceptance (end to end)', () => {
  const packet = '- AC-1: first thing\n- AC-2: second thing\n';

  it('passes when every criterion has a passing test', () => {
    const findings = acceptance(
      packet,
      report([
        ['AC-1: first thing works', 'passed'],
        ['AC-2: second thing works', 'passed'],
      ]),
    );

    expect(findings.filter((finding) => !finding.ok)).toEqual([]);
    expect(findings[0]?.detail).toBe('2 criteria, 2 tests');
  });

  it('AC-3: fails a packet with no criteria rather than passing vacuously', () => {
    // The trivially-green case is exactly the work that most needs the check.
    const findings = acceptance('## Goal\n\nSomething.\n', report([['a test', 'passed']]));

    expect(findings).toHaveLength(1);
    expect(findings[0]?.ok).toBe(false);
    expect(findings[0]?.detail).toContain('no acceptance criteria found');
  });

  it('fails on a reused criterion id', () => {
    const findings = acceptance('- AC-1: a\n- AC-1: b\n', report([['AC-1: x', 'passed']]));
    const check = findings.find((finding) => finding.name === 'criterion ids are unique');

    expect(check?.ok).toBe(false);
    expect(check?.detail).toBe('reused: AC-1');
  });

  it('fails a criterion with an id but no text', () => {
    const findings = acceptance('- AC-1:\n', report([['AC-1: x', 'passed']]));
    const check = findings.find((finding) => finding.name === 'criteria say something');

    expect(check?.ok).toBe(false);
    expect(check?.detail).toBe('no text: AC-1');
  });

  it('AC-4: fails when a test names a criterion the packet dropped', () => {
    const findings = acceptance(
      packet,
      report([
        ['AC-1: a', 'passed'],
        ['AC-2: b', 'passed'],
        ['AC-5: left behind', 'passed'],
      ]),
    );
    const check = findings.find((finding) => finding.name === 'no stale criterion references');

    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('AC-5');
  });

  it('reports an unreadable test report as a finding, not a crash', () => {
    const findings = acceptance(packet, 'not json');

    expect(findings).toHaveLength(1);
    expect(findings[0]?.ok).toBe(false);
    expect(findings[0]?.detail).toContain('unreadable');
  });
});

describe('the CLI verdict', () => {
  it('fails the run when any finding failed, and only then', () => {
    const pass = { name: 'a', ok: true, detail: '' };
    const fail = { name: 'b', ok: false, detail: '' };

    expect(anyFailed([])).toBe(false);
    expect(anyFailed([pass, pass])).toBe(false);
    expect(anyFailed([pass, fail])).toBe(true);
  });
});

describe('acceptance CLI', () => {
  const runCli = (args: string[]): { lines: string[]; exitCode: number | string | undefined } => {
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const originalArgv = process.argv;
    const originalExitCode = process.exitCode;
    process.argv = ['node', 'acceptance.ts', ...args];
    process.exitCode = undefined;
    try {
      main();
      return { lines, exitCode: process.exitCode };
    } finally {
      process.argv = originalArgv;
      process.exitCode = originalExitCode;
      log.mockRestore();
    }
  };

  const withFiles = (packet: string, testReport: string, body: (a: string, b: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), 'athena-acceptance-'));
    try {
      const packetPath = join(dir, 'packet.md');
      const reportPath = join(dir, 'report.json');
      writeFileSync(packetPath, packet);
      writeFileSync(reportPath, testReport);
      body(packetPath, reportPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('exits zero and prints a line per finding when the packet is covered', () => {
    withFiles('- AC-1: a thing\n', report([['AC-1: a thing', 'passed']]), (packet, testReport) => {
      const { lines, exitCode } = runCli([packet, testReport]);

      expect(exitCode).toBeUndefined();
      expect(lines.filter((line) => line.startsWith('FAIL'))).toEqual([]);
      expect(lines).toContain('PASS  AC-1 covered — 1 passing test(s)');
    });
  });

  it('AC-5: exits non-zero when a criterion is uncovered', () => {
    // The exit code is the gate; the printout is only how a human reads it.
    withFiles('- AC-1: a thing\n', report([['unrelated', 'passed']]), (packet, testReport) => {
      const { lines, exitCode } = runCli([packet, testReport]);

      expect(exitCode).toBe(1);
      expect(lines).toContain('FAIL  AC-1 covered — no test names AC-1 — "a thing"');
    });
  });

  it('explains itself when called with no arguments', () => {
    const { lines, exitCode } = runCli([]);

    expect(exitCode).toBe(1);
    expect(lines[0]).toContain('usage: athena acceptance');
  });

  it('explains itself when given only one of the two paths', () => {
    const { lines, exitCode } = runCli(['packet-only.md']);

    expect(exitCode).toBe(1);
    expect(lines[0]).toContain('usage: athena acceptance');
  });

  it('reports a missing file as a finding rather than throwing', () => {
    const { lines, exitCode } = runCli(['no-such-packet.md', 'no-such-report.json']);

    expect(exitCode).toBe(1);
    expect(lines[0]).toContain('FAIL  input');
  });
});

describe('parsing is strict about what counts as a criterion', () => {
  it('ignores an id that appears mid-sentence rather than starting the line', () => {
    // Without the line anchor, any prose mentioning a criterion would become one, and a
    // packet that discusses its own criteria would silently grow extra entries.
    expect(parseCriteria('Note: see AC-5: the earlier packet for context.\n')).toEqual([]);
  });

  it('reads two-digit ids whole', () => {
    // A single-digit pattern would read the first digit and stop, so a packet that got past
    // nine criteria would quietly lose the tenth.
    const criteria = parseCriteria('- AC-9: ninth\n- AC-10: tenth\n- AC-123: later\n');

    expect(criteria.map((criterion) => criterion.id)).toEqual(['AC-9', 'AC-10', 'AC-123']);
  });

  it('trims trailing whitespace off the criterion text', () => {
    expect(parseCriteria('- AC-1: a thing   \n')[0]?.text).toBe('a thing');
  });
});

describe('two-digit criteria are claimed and reported whole', () => {
  it('lets a test claim a two-digit criterion', () => {
    const criteria: Criterion[] = [{ id: 'AC-10', text: 'the tenth thing' }];
    const outcomes: TestOutcome[] = [{ name: 'AC-10: the tenth thing', passed: true }];

    expect(coverageChecks(criteria, outcomes)[0]?.ok).toBe(true);
  });

  it('sorts stale ids so the report reads the same whatever order the tests ran in', () => {
    const outcomes: TestOutcome[] = [
      { name: 'AC-9: later id, earlier test', passed: true },
      { name: 'AC-7: earlier id, later test', passed: true },
    ];

    expect(staleReferences([], outcomes)).toEqual(['AC-7', 'AC-9']);
  });
});

describe('the passing findings say what passed', () => {
  it('names the packet checks it ran', () => {
    // A PASS with an empty reason is what a check looks like once nobody reads it.
    const findings = acceptance('- AC-1: a thing\n', report([['AC-1: a thing', 'passed']]));
    const detail = (name: string) => findings.find((finding) => finding.name === name)?.detail;

    expect(detail('criterion ids are unique')).toBe('no id used twice');
    expect(detail('criteria say something')).toBe('every criterion has text');
    expect(detail('no stale criterion references')).toBe('every id a test names is in the packet');
  });
});
