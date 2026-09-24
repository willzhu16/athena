import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  acceptance,
  acceptanceAll,
  anyFailed,
  type Criterion,
  coverageChecks,
  main,
  packetFiles,
  parseCriteria,
  parseTestReport,
  staleReferences,
  type TestOutcome,
} from './acceptance.ts';

/** A vitest JSON report carrying the given test names and outcomes. */
/** A throwaway directory seeded with the given files, matching the doctor tests style. */
const scratchDir = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), 'athena-acceptance-'));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents);
  }
  return dir;
};
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

describe('reading a pytest report', () => {
  /** What `pytest --json-report` (pytest-json-report) writes. */
  const pytestReport = (tests: [string, string][]): string =>
    JSON.stringify({
      tests: tests.map(([nodeid, outcome]) => ({ nodeid, outcome })),
      summary: { total: tests.length },
    });

  it('AC-7: reads a pytest report as readily as a vitest one', () => {
    // Shape detection rather than configuration: a repo declaring its runner in a second
    // place is a declaration that can drift from the truth.
    const outcomes = parseTestReport(
      pytestReport([
        ['tests/test_auth.py::test_ac_1_rejects_an_expired_token', 'passed'],
        ['tests/test_auth.py::test_retries_three_times', 'failed'],
      ]),
    );

    expect(outcomes).toEqual([
      { name: 'tests/test_auth.py::test_ac_1_rejects_an_expired_token', passed: true },
      { name: 'tests/test_auth.py::test_retries_three_times', passed: false },
    ]);
  });

  it('counts only an outright pass, so xfail and skip are not evidence', () => {
    const outcomes = parseTestReport(
      pytestReport([
        ['tests/test_a.py::test_one', 'skipped'],
        ['tests/test_a.py::test_two', 'xfailed'],
        ['tests/test_a.py::test_three', 'error'],
      ]),
    );

    expect(outcomes.every((outcome) => !outcome.passed)).toBe(true);
  });

  it('survives a pytest report whose entries carry no nodeid', () => {
    expect(parseTestReport(JSON.stringify({ tests: [{ outcome: 'passed' }] }))).toEqual([
      { name: '', passed: true },
    ]);
  });

  it('AC-8: lets a pytest test claim a criterion in identifier spelling', () => {
    // Python cannot put `-` or `:` in a function name, so the claim is `ac_1_`. One concept,
    // two spellings, each idiomatic where it is used.
    const criteria: Criterion[] = [{ id: 'AC-1', text: 'rejects an expired token' }];
    const outcomes = parseTestReport(
      pytestReport([['tests/test_auth.py::test_ac_1_rejects_an_expired_token', 'passed']]),
    );

    expect(coverageChecks(criteria, outcomes)[0]?.ok).toBe(true);
    expect(staleReferences(criteria, outcomes)).toEqual([]);
  });

  it('AC-9: does not let an id inside a longer word claim anything', () => {
    // Without a boundary, `test_mac_10_thing` claims AC-10 and `MAC-1:` claims AC-1.
    const criteria: Criterion[] = [{ id: 'AC-10', text: 'the tenth thing' }];
    const outcomes = parseTestReport(
      pytestReport([['tests/test_net.py::test_mac_10_address_parses', 'passed']]),
    );

    expect(coverageChecks(criteria, outcomes)[0]?.ok).toBe(false);
    expect(staleReferences([], [{ name: 'MAC-1: not a claim', passed: true }])).toEqual([]);
  });

  it('still claims from an uppercase dash form, so TypeScript is unchanged', () => {
    const criteria: Criterion[] = [{ id: 'AC-3', text: 'x' }];

    expect(coverageChecks(criteria, [{ name: 'AC-3: does the thing', passed: true }])[0]?.ok).toBe(
      true,
    );
  });
});

describe('every packet gets checked, not just the one someone named', () => {
  const packet = (id: string): string =>
    ['# Task packet', '', '**Acceptance criteria**', '', `- ${id}: something observable`].join(
      '\n',
    );
  const report = (names: string[]): string =>
    JSON.stringify({
      testResults: [
        { assertionResults: names.map((title) => ({ fullName: title, status: 'passed' })) },
      ],
    });

  it('resolves a single file to itself, so the workflow that names one packet is unchanged', () => {
    // platform's reusable acceptance workflow resolves one packet from the issue a PR closes
    // and passes that path. Breaking the single-file form would break every generated repo.
    const dir = scratchDir({ 'one.md': packet('AC-1') });
    try {
      expect(packetFiles(join(dir, 'one.md'))).toEqual([join(dir, 'one.md')]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves a directory to every packet in it, sorted', () => {
    const dir = scratchDir({
      'b.md': packet('AC-2'),
      'a.md': packet('AC-1'),
      'notes.txt': 'not a packet',
    });
    try {
      expect(packetFiles(dir).map((path) => basename(path))).toEqual(['a.md', 'b.md']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails a second packet whose criterion nothing covers', () => {
    // The gap this closes. check.ps1 named one packet, so a second one beside it was read by
    // nothing: its criteria went unchecked while the step reported green.
    const findings = acceptanceAll(
      [
        { name: 'first', source: packet('AC-1') },
        { name: 'second', source: packet('AC-2') },
      ],
      report(['AC-1: covered by this test']),
    );

    expect(findings.some((finding) => !finding.ok && finding.name.includes('second'))).toBe(true);
    expect(anyFailed(findings)).toBe(true);
  });

  it('prefixes findings with the packet once there is more than one', () => {
    // "AC-1 covered" says nothing about which packet's AC-1 when two are checked together.
    const findings = acceptanceAll(
      [
        { name: 'alpha', source: packet('AC-1') },
        { name: 'beta', source: packet('AC-1') },
      ],
      report(['AC-1: covered']),
    );

    expect(findings.every((finding) => /^(alpha|beta): /.test(finding.name))).toBe(true);
  });

  it('leaves names alone for a single packet, so existing output does not churn', () => {
    const findings = acceptanceAll(
      [{ name: 'only', source: packet('AC-1') }],
      report(['AC-1: yes']),
    );

    expect(findings.every((finding) => !finding.name.startsWith('only: '))).toBe(true);
  });

  it('fails when no packets were found rather than passing vacuously', () => {
    // A directory matching nothing looks identical to a directory whose every criterion is
    // covered. The second reading is how a renamed folder turns the gate off silently.
    const findings = acceptanceAll([], report([]));

    expect(anyFailed(findings)).toBe(true);
    expect(findings[0]?.detail).toContain('nothing was checked');
  });
});

describe('the gate CI actually runs', () => {
  const workflow = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '.github', 'workflows', 'acceptance.yml'),
    'utf8',
  );

  it('points the gate at the packets directory, not one named file', () => {
    // check.ps1 reads every packet and this workflow read one, so a second packet added
    // beside the first was checked on the author's machine and ignored by the check that
    // blocks the merge. That is exactly the failure acceptanceAll was written to prevent,
    // left alive in the only place where it decides anything.
    const invocation = workflow
      .split('\n')
      .find((line) => line.includes('pnpm acceptance') && !line.trimStart().startsWith('#'));

    expect(invocation).toBeDefined();
    expect(invocation).toContain('pnpm acceptance packets reports/tests.json');
  });
});

describe('more than one packet in the same run', () => {
  const twoPackets = [
    { name: 'first', source: '- AC-1: does a thing\n' },
    { name: 'second', source: '- AC-2: does another thing\n' },
  ];
  const bothCovered = JSON.stringify({
    testResults: [
      {
        assertionResults: [
          { fullName: 'AC-1: covers the first', status: 'passed' },
          { fullName: 'AC-2: covers the second', status: 'passed' },
        ],
      },
    ],
  });

  it('does not report one packet ids as stale because they belong to another', () => {
    // Every criterion here is covered and nothing is wrong, but the stale check ran per
    // packet against one packet's ids, so each packet called the other's ids unknown. The
    // gate therefore went red the moment a second packet existed — which is the whole
    // feature — and the obvious way to quieten it is to delete the stale check that catches
    // criteria renamed out from under a test.
    const findings = acceptanceAll(twoPackets, bothCovered);

    expect(anyFailed(findings)).toBe(false);
  });

  it('still catches an id no packet anywhere lists', () => {
    // The other half: widening the known set must not turn the check off. AC-3 belongs to
    // no packet, so it is a test asserting something nobody asked for.
    const findings = acceptanceAll(
      twoPackets,
      JSON.stringify({
        testResults: [
          {
            assertionResults: [
              { fullName: 'AC-1: covers the first', status: 'passed' },
              { fullName: 'AC-2: covers the second', status: 'passed' },
              { fullName: 'AC-3: covers nothing in any packet', status: 'passed' },
            ],
          },
        ],
      }),
    );

    expect(anyFailed(findings)).toBe(true);
    expect(findings.some((finding) => finding.detail.includes('AC-3'))).toBe(true);
  });

  it('leaves the single-packet reading exactly as it was', () => {
    // A lone packet has no siblings to borrow ids from, so an id it does not list is still
    // stale. Widening the set must not weaken the one-packet case.
    const findings = acceptanceAll(
      [{ name: 'only', source: '- AC-1: does a thing\n' }],
      bothCovered,
    );

    expect(anyFailed(findings)).toBe(true);
    expect(findings.some((finding) => finding.detail.includes('AC-2'))).toBe(true);
  });
});
