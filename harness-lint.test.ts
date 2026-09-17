import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  type AcknowledgedDeny,
  anyFailed,
  BUNDLE_TOKEN_BUDGET,
  type BundleCost,
  bashCommand,
  budgetCheck,
  bundleCosts,
  COHERENCE_FILE,
  type CoherenceClaim,
  type CoherenceFile,
  claimChecks,
  codexSecretsCheck,
  commandCosts,
  commandCrossLinkCheck,
  commandDuplicateCheck,
  commandEchoes,
  commandFrontmatterChecks,
  commandsManifestCheck,
  denySoundnessChecks,
  duplicateCheck,
  duplicateLines,
  type HarnessReport,
  harnessLint,
  hooksManifestCheck,
  hooksWiredCheck,
  isOrderSensitive,
  main,
  normalizeLine,
  printReport,
  readCoherence,
  readProfile,
  SCORECARD_FILE,
  scorecardCheck,
  serializeScorecard,
  unsoundDenies,
  writeScorecard,
} from './harness-lint.ts';

const athenaDir = dirname(fileURLToPath(import.meta.url));
const instructionsDir = join(athenaDir, 'instructions');
const permissionsDir = join(athenaDir, 'permissions');

/** A throwaway directory seeded with the given files, mirroring the doctor tests' style. */
const scratchDir = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), 'athena-harness-'));
  for (const [name, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), contents);
  }
  return dir;
};

const profile = (deny: string[]): string => JSON.stringify({ permissions: { allow: [], deny } });

describe('deny-rule soundness', () => {
  it('flags a deny pattern that names a flag', () => {
    // Regression: REVIEW-2026-07-15 finding #7 — permission rules match the leading text
    // of a command, so `Bash(git push --force:*)` never sees `git push origin main --force`.
    expect(isOrderSensitive('git push --force')).toBe(true);
    expect(isOrderSensitive('git push -f')).toBe(true);
  });

  it('leaves a deny pattern with no flag alone', () => {
    expect(isOrderSensitive('wrangler deploy')).toBe(false);
    expect(isOrderSensitive('sops exec-env')).toBe(false);
  });

  it('reads the command out of a Bash rule and ignores non-Bash rules', () => {
    expect(bashCommand('Bash(git push --force:*)')).toBe('git push --force');
    expect(bashCommand('Bash(pnpm:*)')).toBe('pnpm');
    expect(bashCommand('Write(secrets/**)')).toBeNull();
  });

  it('finds the evadable rules in the profile actually shipped to repos', () => {
    const unsound = unsoundDenies(readProfile(permissionsDir, 't1'));

    expect(unsound).toContain('Bash(git push --force:*)');
    expect(unsound.every((rule) => (bashCommand(rule) ?? '').includes(' -'))).toBe(true);
  });

  it('fails a profile whose evadable rule carries no acknowledgement', () => {
    const dir = scratchDir({ 't9.settings.json': profile(['Bash(git push --force:*)']) });
    try {
      const [finding] = denySoundnessChecks(dir, []);

      expect(finding?.ok).toBe(false);
      expect(finding?.detail).toContain('unacknowledged Bash(git push --force:*)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails an acknowledgement left behind after its rule was removed', () => {
    // Without this the manifest silently accumulates entries for rules that no longer
    // exist, and stops being evidence of anything.
    const dir = scratchDir({ 't9.settings.json': profile(['Bash(wrangler deploy:*)']) });
    const stale: AcknowledgedDeny[] = [
      { profile: 't9', rule: 'Bash(git push --force:*)', reason: 'gone' },
    ];
    try {
      const [finding] = denySoundnessChecks(dir, stale);

      expect(finding?.ok).toBe(false);
      expect(finding?.detail).toContain('stale acknowledgement');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('rulebook / permission coherence', () => {
  it.each([
    ['Bash(gh secret list:*)', false],
    ['Bash(gh secrets:*)', false],
    ['Bash(gh secret)', false],
    ['Bash(gh secret:*)', true],
    ['Bash(gh secret *)', true],
    ['Bash(gh:*)', true],
    ['Bash', true],
  ])('checks command-family coverage for %s', (rule, expected) => {
    const layers = scratchDir({ 'security.md': 'Do not run gh secret.' });
    const perms = scratchDir({ 't9.settings.json': profile([rule]) });
    try {
      const [finding] = claimChecks(
        [
          {
            command: 'gh secret',
            statedIn: ['security.md'],
            enforcement: 'denied',
            deniedIn: ['t9'],
          },
        ],
        layers,
        perms,
      );
      expect(finding?.ok).toBe(expected);
    } finally {
      rmSync(layers, { recursive: true, force: true });
      rmSync(perms, { recursive: true, force: true });
    }
  });

  it.each([{ deniedIn: [] }, { statedIn: [] }, { command: '' }])(
    'rejects a vacuous claim: %j',
    (override) => {
      const layers = scratchDir({ 'security.md': 'Do not run gh secret.' });
      const perms = scratchDir({ 't9.settings.json': profile(['Bash(gh secret:*)']) });
      try {
        const [finding] = claimChecks(
          [
            {
              command: 'gh secret',
              statedIn: ['security.md'],
              enforcement: 'denied',
              deniedIn: ['t9'],
              ...override,
            },
          ],
          layers,
          perms,
        );
        expect(finding?.ok).toBe(false);
      } finally {
        rmSync(layers, { recursive: true, force: true });
        rmSync(perms, { recursive: true, force: true });
      }
    },
  );

  it('rejects a denied claim with no deniedIn list instead of throwing on it', () => {
    // readCoherence rejects this shape on the way in, but claimChecks is exported and
    // callable on its own. It has to report the gap the way every other finding does,
    // because a claim with no profile behind it is a wall nobody is enforcing.
    const layers = scratchDir({ 'security.md': 'Do not run gh secret.' });
    const perms = scratchDir({ 't9.settings.json': profile(['Bash(gh secret:*)']) });
    const noProfiles = {
      command: 'gh secret',
      statedIn: ['security.md'],
      enforcement: 'denied',
    } as CoherenceClaim;
    try {
      const [finding] = claimChecks([noProfiles], layers, perms);

      expect(finding?.ok).toBe(false);
      expect(finding?.detail).toBe('denied claim needs at least one permission profile');
    } finally {
      rmSync(layers, { recursive: true, force: true });
      rmSync(perms, { recursive: true, force: true });
    }
  });

  const denied: CoherenceClaim = {
    command: 'sops -d',
    statedIn: ['10-security.md'],
    enforcement: 'denied',
    deniedIn: ['t9'],
  };

  it('fails when a layer stops stating a command the profile still denies', () => {
    const layers = scratchDir({ '10-security.md': '# Security\n\nNothing about that here.\n' });
    const perms = scratchDir({ 't9.settings.json': profile(['Bash(sops -d:*)']) });
    try {
      const [finding] = claimChecks([denied], layers, perms);

      expect(finding?.ok).toBe(false);
      expect(finding?.detail).toContain('no longer stated in 10-security.md');
    } finally {
      rmSync(layers, { recursive: true, force: true });
      rmSync(perms, { recursive: true, force: true });
    }
  });

  it('fails when a profile stops denying a command the layer still states', () => {
    const layers = scratchDir({ '10-security.md': '# Security\n\nDo not run `sops -d`.\n' });
    const perms = scratchDir({ 't9.settings.json': profile(['Bash(wrangler deploy:*)']) });
    try {
      const [finding] = claimChecks([denied], layers, perms);

      expect(finding?.ok).toBe(false);
      expect(finding?.detail).toContain('not denied in t9');
    } finally {
      rmSync(layers, { recursive: true, force: true });
      rmSync(perms, { recursive: true, force: true });
    }
  });

  it('reports a claim naming a profile that does not exist as a failed check', () => {
    // Regression: a hand-edited manifest pointing at a deleted tier threw ENOENT out of
    // harnessLint. Like doctor, this tool reports problems — it never crashes on them.
    const layers = scratchDir({ '10-security.md': '# Security\n\nDo not run `sops -d`.\n' });
    const perms = scratchDir({ 't1.settings.json': profile([]) });
    try {
      const [finding] = claimChecks([denied], layers, perms);

      expect(finding?.ok).toBe(false);
      expect(finding?.detail).toContain('no profile on disk for t9');
    } finally {
      rmSync(layers, { recursive: true, force: true });
      rmSync(perms, { recursive: true, force: true });
    }
  });

  it('requires an advisory claim to say why it is not enforced', () => {
    const layers = scratchDir({ '10-security.md': '# Security\n\nAvoid `.github/workflows/`.\n' });
    const perms = scratchDir({ 't9.settings.json': profile([]) });
    const advisory: CoherenceClaim = {
      command: '.github/workflows/',
      statedIn: ['10-security.md'],
      enforcement: 'advisory',
    };
    try {
      const [finding] = claimChecks([advisory], layers, perms);

      expect(finding?.ok).toBe(false);
      expect(finding?.detail).toContain('no reason');
    } finally {
      rmSync(layers, { recursive: true, force: true });
      rmSync(perms, { recursive: true, force: true });
    }
  });
});

describe('bundle cost', () => {
  it('prices one bundle per stack and target combination', () => {
    const costs = bundleCosts(instructionsDir);
    const stacks = new Set(costs.map((cost) => cost.stack));

    expect(stacks).toEqual(new Set(['ts', 'python']));
    // Two targets on disk means four subsets (none, each, both) per stack.
    expect(costs.filter((cost) => cost.stack === 'ts')).toHaveLength(4);
    expect(costs.every((cost) => cost.estimatedTokens > 0)).toBe(true);
  });

  it('holds the worst-case bundle to the budget', () => {
    expect(budgetCheck(bundleCosts(instructionsDir)).ok).toBe(true);
  });

  it('fails once the worst-case bundle outgrows the budget', () => {
    const over: BundleCost[] = [
      { stack: 'ts', targets: [], chars: 40, lines: 1, estimatedTokens: BUNDLE_TOKEN_BUDGET + 1 },
    ];

    const finding = budgetCheck(over);

    expect(finding.ok).toBe(false);
    expect(finding.detail).toContain('exceeds budget');
  });
});

describe('duplicate rule lines', () => {
  const rule = 'Prefer real implementations over mocks in every test.';

  it('catches the same rule stated twice', () => {
    expect(duplicateLines(`- ${rule}\n\nsomething else entirely\n\n- ${rule}\n`)).toEqual([
      rule.toLowerCase(),
    ]);
  });

  it('ignores short repeated lines that are structure, not rules', () => {
    expect(duplicateLines('## Testing\n\n## Testing\n\n- ok\n- ok\n')).toEqual([]);
  });

  it('fails a bundle that states one rule twice', () => {
    // Two layers that load together, so the repeat is paid for on every request.
    const layers = scratchDir({
      '00-universal.md': `# Universal\n\n- ${rule}\n`,
      '10-security.md': '# Security\n\nNothing repeated here.\n',
      '20-stack-ts.md': `# TypeScript\n\n- ${rule}\n`,
    });
    try {
      const finding = duplicateCheck(layers);

      expect(finding.ok).toBe(false);
      expect(finding.detail).toContain('repeated rule lines');
    } finally {
      rmSync(layers, { recursive: true, force: true });
    }
  });
});

describe('harnessLint', () => {
  it.each([
    { claims: [null], acknowledgedUnsoundDenies: [] },
    { claims: [{ command: 42 }], acknowledgedUnsoundDenies: [] },
    {
      claims: [
        {
          command: 'gh secret',
          statedIn: ['10-security.md'],
          enforcement: 'denied',
          deniedIn: ['t1'],
        },
      ],
      acknowledgedUnsoundDenies: [null],
    },
  ])('reports malformed manifest entries without crashing: %j', (manifest) => {
    const perms = scratchDir({
      'coherence.json': JSON.stringify(manifest),
      't1.settings.json': profile(['Bash(gh secret:*)']),
    });
    try {
      const report = harnessLint(instructionsDir, perms);
      expect(report.findings).toEqual([expect.objectContaining({ name: 'coherence', ok: false })]);
    } finally {
      rmSync(perms, { recursive: true, force: true });
    }
  });

  it.each(['null', '{}', '{"claims":[],"acknowledgedUnsoundDenies":[]}'])(
    'reports malformed manifest %s as FAIL',
    (contents) => {
      const perms = scratchDir({ 'coherence.json': contents });
      try {
        const report = harnessLint(instructionsDir, perms);
        expect(report.findings.some((finding) => !finding.ok)).toBe(true);
      } finally {
        rmSync(perms, { recursive: true, force: true });
      }
    },
  );
  it('passes against the harness actually shipped today', () => {
    const report = harnessLint(instructionsDir, permissionsDir);
    const failures = report.findings.filter((finding) => !finding.ok);

    expect(failures).toEqual([]);
    expect(report.findings.length).toBeGreaterThan(0);
  });

  it('reports a missing coherence manifest as a failed check instead of throwing', () => {
    const perms = scratchDir({ 't1.settings.json': profile([]) });
    try {
      const report = harnessLint(instructionsDir, perms);

      expect(report.findings).toHaveLength(1);
      expect(report.findings[0]?.ok).toBe(false);
      expect(report.findings[0]?.detail).toContain('unreadable coherence.json');
    } finally {
      rmSync(perms, { recursive: true, force: true });
    }
  });
});

/** A minimal well-formed slash command: frontmatter with a description, then a body. */
const command = (description: string, body = 'Do the thing carefully and completely.\n'): string =>
  `---\ndescription: ${description}\n---\n\n${body}`;

describe('slash commands', () => {
  it('accepts a directory that matches the COMMANDS list', () => {
    const dir = scratchDir({ 'conductor.md': command('Run the conductor') });
    try {
      expect(commandsManifestCheck(dir).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails a command file COMMANDS does not list', () => {
    // Regression: an orphan file is never installed by compile, so the command simply does
    // not exist in generated repos and nothing says why.
    const dir = scratchDir({
      'conductor.md': command('Run the conductor'),
      'stowaway.md': command('Never ships'),
    });
    try {
      const finding = commandsManifestCheck(dir);

      expect(finding.ok).toBe(false);
      expect(finding.detail).toContain('stowaway.md');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when COMMANDS names a file that is not on disk', () => {
    const dir = scratchDir({ 'unrelated.txt': 'x' });
    try {
      const finding = commandsManifestCheck(dir);

      expect(finding.ok).toBe(false);
      expect(finding.detail).toContain('conductor.md');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails a command with no frontmatter block', () => {
    const dir = scratchDir({ 'conductor.md': 'Just a body, no frontmatter.\n' });
    try {
      const [finding] = commandFrontmatterChecks(dir);

      expect(finding?.ok).toBe(false);
      expect(finding?.detail).toContain('no --- frontmatter');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails a command whose frontmatter has no description', () => {
    // The command still installs; it just shows up unlabelled in the command list, which
    // is invisible until someone goes looking for it.
    const dir = scratchDir({ 'conductor.md': '---\nargument-hint: <spec>\n---\n\nBody.\n' });
    try {
      const [finding] = commandFrontmatterChecks(dir);

      expect(finding?.ok).toBe(false);
      expect(finding?.detail).toContain('no description');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when a process doc never references the command it describes', () => {
    // conductor.md asks a human to "keep the two in step". This is that request, tested.
    const dir = scratchDir({
      'commands/conductor.md': command('Run the conductor'),
      'conductor.md': '# Conductor mode\n\nA protocol with no pointer at its command.\n',
    });
    try {
      const finding = commandCrossLinkCheck(join(dir, 'commands'));

      expect(finding.ok).toBe(false);
      expect(finding.detail).toContain('conductor.md');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts a process doc that points at its command', () => {
    const dir = scratchDir({
      'commands/conductor.md': command('Run the conductor'),
      'conductor.md': '# Conductor mode\n\nSee `commands/conductor.md` for the shipped one.\n',
    });
    try {
      expect(commandCrossLinkCheck(join(dir, 'commands')).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails a command that states the same line twice', () => {
    const line = 'Stop and get the packet split approved first.';
    const dir = scratchDir({ 'conductor.md': command('x', `- ${line}\n\nmiddle\n\n- ${line}\n`) });
    try {
      const finding = commandDuplicateCheck(dir);

      expect(finding.ok).toBe(false);
      expect(finding.detail).toContain('conductor.md');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prices every command file', () => {
    const dir = scratchDir({ 'conductor.md': command('Run the conductor') });
    try {
      const [cost] = commandCosts(dir);

      expect(cost?.name).toBe('conductor.md');
      expect(cost?.estimatedTokens).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prices nothing when the commands directory does not exist', () => {
    // harness-lint reports and never throws. A repo that has not added commands yet still
    // has to lint, with the missing directory surfacing as a failed manifest check instead.
    const dir = scratchDir({ 'placeholder.md': 'not the commands directory' });
    try {
      expect(commandCosts(join(dir, 'commands'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a line a command shares with an instruction layer', () => {
    // A command and a layer that state the same rule drift in pairs: edit one copy and the
    // other goes stale. This list is the only thing that notices.
    const shared = 'Stop and get the packet split approved before you start.';
    const layers = scratchDir({ '00-universal.md': `# Universal\n\n- ${shared}\n` });
    const commands = scratchDir({
      'conductor.md': command('Run the conductor', `${shared}\n`),
    });
    try {
      const echoes = commandEchoes(layers, commands);

      expect(echoes).toHaveLength(1);
      expect(echoes[0]?.line).toBe(normalizeLine(shared));
      expect(echoes[0]?.layers).toEqual(['commands/conductor.md', '00-universal.md']);
    } finally {
      rmSync(layers, { recursive: true, force: true });
      rmSync(commands, { recursive: true, force: true });
    }
  });

  it('reports nothing when no command line appears in a layer', () => {
    // The other half of the pair: an echo list that fires on unrelated text would be noise
    // nobody reads, and the real echo would be lost in it.
    const layers = scratchDir({
      '00-universal.md': '# Universal\n\nNothing in common here.\n',
    });
    const commands = scratchDir({ 'conductor.md': command('Run the conductor') });
    try {
      expect(commandEchoes(layers, commands)).toEqual([]);
    } finally {
      rmSync(layers, { recursive: true, force: true });
      rmSync(commands, { recursive: true, force: true });
    }
  });
});

describe('harness scorecard', () => {
  const currentScorecard = () => {
    const { scorecard } = harnessLint(instructionsDir, permissionsDir);
    if (scorecard === null) {
      throw new Error('the shipped harness should always produce a scorecard');
    }
    return scorecard;
  };

  it('measures the same numbers twice in a row', () => {
    // The committed file is only useful as a diff if identical inputs serialize identically.
    expect(serializeScorecard(currentScorecard())).toBe(serializeScorecard(currentScorecard()));
  });

  it('reports a missing scorecard as a failed check', () => {
    const dir = scratchDir({ 'placeholder.txt': 'x' });
    try {
      const finding = scorecardCheck(dir, currentScorecard());

      expect(finding.ok).toBe(false);
      expect(finding.detail).toContain('missing');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a scorecard that no longer matches the measurement', () => {
    // Regression: the bundle grew ~20% across three sessions with nobody noticing, because
    // the number only ever appeared on the screen of whoever ran the CLI.
    const dir = scratchDir({ [SCORECARD_FILE]: '{\n  "bundles": "from an older run"\n}\n' });
    try {
      const finding = scorecardCheck(dir, currentScorecard());

      expect(finding.ok).toBe(false);
      expect(finding.detail).toContain('stale');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts the scorecard it just wrote', () => {
    const dir = scratchDir({ 'placeholder.txt': 'x' });
    try {
      const scorecard = currentScorecard();
      writeScorecard(dir, scorecard);

      expect(scorecardCheck(dir, scorecard).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('codex / claude secret coherence', () => {
  it('passes for every tier actually shipped', () => {
    const findings = codexSecretsCheck(permissionsDir);

    expect(findings.map((finding) => finding.name).sort()).toEqual([
      'codex t0 secret denials',
      'codex t1 secret denials',
      'codex t2 secret denials',
    ]);
    expect(findings.filter((finding) => !finding.ok)).toEqual([]);
  });

  it('fails when a tier has a claude profile but no codex counterpart', () => {
    // The pairing is the point: a tier that ships for one agent and not the other is how
    // `tier: 2` would quietly mean different things depending on which tool read it.
    const dir = scratchDir({ 't2.settings.json': profile(['Read(secrets/**)']) });
    try {
      const finding = codexSecretsCheck(dir).find((entry) => entry.name.includes('t2'));

      expect(finding?.ok).toBe(false);
      expect(finding?.detail).toContain('codex.t2.config.toml');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when a codex profile stops denying a secret path its claude profile denies', () => {
    const dir = scratchDir({
      't1.settings.json': profile(['Read(secrets/**)', 'Read(**/.env)']),
      'codex.t1.config.toml': '[permissions.x.filesystem]\n"**/.env" = "deny"\n',
      // Both Codex halves must exist or the pairing check fires before the denial check.
      'codex.t1.rules': 'prefix_rule(pattern = ["rm"], decision = "forbidden")\n',
    });
    try {
      const finding = codexSecretsCheck(dir).find((entry) => entry.name.includes('t1'));

      expect(finding?.ok).toBe(false);
      expect(finding?.detail).toContain('secrets/**');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says nothing is required for a tier that ships no profile at all', () => {
    const dir = scratchDir({ 'placeholder.txt': 'x' });
    try {
      expect(codexSecretsCheck(dir).every((finding) => finding.ok)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('coherence manifest validation', () => {
  // The manifest is the tested bridge between what the layers say and what the profiles
  // enforce. A malformed one that loaded anyway would report coherence it never checked, so
  // every rejection below is part of the guarantee rather than defensive noise.
  const validManifest = {
    claims: [
      {
        command: 'rm -rf',
        statedIn: ['00-universal.md'],
        enforcement: 'denied',
        deniedIn: ['t1.settings.json'],
      },
    ],
    acknowledgedUnsoundDenies: [
      { profile: 't1.settings.json', rule: 'Bash(git push:*)', reason: 'prefix is broader' },
    ],
  };

  const read = (manifest: unknown): CoherenceFile => {
    const dir = scratchDir({ [COHERENCE_FILE]: JSON.stringify(manifest) });
    try {
      return readCoherence(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const claimWith = (overrides: Record<string, unknown>) => ({
    ...validManifest,
    claims: [{ ...validManifest.claims[0], ...overrides }],
  });

  it('accepts a well-formed manifest', () => {
    const manifest = read(validManifest);

    expect(manifest.claims).toHaveLength(1);
    expect(manifest.acknowledgedUnsoundDenies).toHaveLength(1);
  });

  const shapeRejections: [string, unknown][] = [
    ['null instead of an object', null],
    ['claims missing entirely', { acknowledgedUnsoundDenies: [] }],
    ['claims that are not an array', { ...validManifest, claims: 'rm -rf' }],
    ['an empty claims list', { ...validManifest, claims: [] }],
    ['acknowledgedUnsoundDenies missing', { claims: validManifest.claims }],
    [
      'acknowledgedUnsoundDenies that is not an array',
      { ...validManifest, acknowledgedUnsoundDenies: {} },
    ],
  ];

  for (const [description, manifest] of shapeRejections) {
    it(`rejects ${description}`, () => {
      expect(() => read(manifest)).toThrow(/non-empty claims and an acknowledgedUnsoundDenies/);
    });
  }

  it('rejects a claim that is not an object', () => {
    expect(() => read({ ...validManifest, claims: [null] })).toThrow(/invalid coherence claim/);
  });

  const claimRejections: [string, Record<string, unknown>][] = [
    ['a command that is not a string', { command: 42 }],
    ['a blank command', { command: '   ' }],
    ['statedIn missing', { statedIn: undefined }],
    ['statedIn that is not an array', { statedIn: '00-universal.md' }],
    ['an empty statedIn', { statedIn: [] }],
    ['a statedIn entry that is not a string', { statedIn: [7] }],
    ['a blank statedIn entry', { statedIn: ['  '] }],
    ['an enforcement value that is neither denied nor advisory', { enforcement: 'maybe' }],
    ['a denied claim with no deniedIn', { deniedIn: undefined }],
    ['a denied claim with an empty deniedIn', { deniedIn: [] }],
    ['a denied claim whose deniedIn holds a blank name', { deniedIn: [' '] }],
    ['an advisory claim with no reason', { enforcement: 'advisory', deniedIn: undefined }],
    [
      'an advisory claim with a blank reason',
      { enforcement: 'advisory', deniedIn: undefined, reason: ' ' },
    ],
  ];

  for (const [description, overrides] of claimRejections) {
    it(`rejects ${description}`, () => {
      expect(() => read(claimWith(overrides))).toThrow(/invalid coherence claim/);
    });
  }

  it('accepts an advisory claim that carries a reason', () => {
    const manifest = read(
      claimWith({ enforcement: 'advisory', deniedIn: undefined, reason: 'judgement call' }),
    );

    expect(manifest.claims[0]?.enforcement).toBe('advisory');
  });

  const acknowledgementRejections: [string, unknown][] = [
    ['an acknowledgement that is not an object', null],
    ['an acknowledgement with no profile', { rule: 'Bash(x:*)', reason: 'why' }],
    ['an acknowledgement with no rule', { profile: 't1.settings.json', reason: 'why' }],
    ['an acknowledgement with a blank reason', { profile: 't1', rule: 'Bash(x:*)', reason: '' }],
  ];

  for (const [description, entry] of acknowledgementRejections) {
    it(`rejects ${description}`, () => {
      const manifest = { ...validManifest, acknowledgedUnsoundDenies: [entry] };

      expect(() => read(manifest)).toThrow(/invalid deny acknowledgement/);
    });
  }
});

describe('bundle budget (which bundle it prices)', () => {
  const cost = (stack: string, estimatedTokens: number): BundleCost => ({
    stack,
    targets: [],
    chars: estimatedTokens * 4,
    lines: 10,
    estimatedTokens,
  });

  it('prices the largest bundle, not the last one measured', () => {
    // The budget only means something applied to the worst case. Reporting any other bundle
    // would let the largest configuration drift past the ceiling unnoticed.
    const finding = budgetCheck([cost('big', 3000), cost('small', 10)]);

    // Reads the constant rather than repeating its value: the budget is meant to move by
    // deliberate decision, and a test that has to be edited on every legitimate raise
    // teaches people to edit tests. What this pins down is WHICH bundle gets priced.
    expect(finding.detail).toBe(`worst case big+none ~3000 tokens (budget ${BUNDLE_TOKEN_BUDGET})`);
  });

  it('keeps the first of two equally large bundles rather than the later one', () => {
    expect(budgetCheck([cost('first', 500), cost('second', 500)]).detail).toContain('first+none');
  });

  it('passes exactly at the budget', () => {
    const finding = budgetCheck([cost('exact', BUNDLE_TOKEN_BUDGET)]);

    expect(finding.ok).toBe(true);
    expect(finding.detail).toBe(
      `worst case exact+none ~${BUNDLE_TOKEN_BUDGET} tokens (budget ${BUNDLE_TOKEN_BUDGET})`,
    );
  });

  it('fails rather than passing vacuously when there are no bundles at all', () => {
    const finding = budgetCheck([]);

    expect(finding.ok).toBe(false);
    expect(finding.detail).toBe('no bundles — instruction layers missing');
  });
});

describe('codex / claude secret coherence (what each tier is required to deny)', () => {
  const codexRules = 'prefix_rule(pattern = ["rm"], decision = "forbidden")\n';

  it('names the paths it confirmed, not just that it passed', () => {
    const details = new Map(
      codexSecretsCheck(permissionsDir).map((finding) => [finding.name, finding.detail]),
    );

    expect(details.get('codex t1 secret denials')).toBe(
      'codex.t1.config.toml denies secrets/**, .env',
    );
    expect(details.get('codex t0 secret denials')).toBe(
      'codex.t0.config.toml denies secrets/**, .env',
    );
  });

  it('requires t0 to deny secrets even if its claude profile stops naming them', () => {
    // t0 is the tier handed to an unattended run, so its secret denials are asserted
    // outright rather than mirrored from the claude profile. Mirroring would mean a rule
    // deleted on the claude side silently stops being required on the codex side too.
    const dir = scratchDir({
      't0.settings.json': profile(['Bash(rm:*)']),
      'codex.t0.config.toml': '[permissions.x.filesystem]\n"docs/**" = "deny"\n',
      'codex.t0.rules': codexRules,
    });
    try {
      const finding = codexSecretsCheck(dir).find((entry) => entry.name.includes('t0'));

      expect(finding?.ok).toBe(false);
      expect(finding?.detail).toBe('codex.t0.config.toml does not deny: secrets/**, .env');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires nothing of a higher tier whose claude profile names no secret paths', () => {
    // Above t0 the codex profile mirrors the claude one, so there is nothing to mirror.
    const dir = scratchDir({
      't1.settings.json': profile(['Bash(rm:*)']),
      'codex.t1.config.toml': '[permissions.x.filesystem]\n"docs/**" = "deny"\n',
      'codex.t1.rules': codexRules,
    });
    try {
      const finding = codexSecretsCheck(dir).find((entry) => entry.name.includes('t1'));

      expect(finding?.ok).toBe(true);
      expect(finding?.detail).toBe('codex.t1.config.toml denies nothing required');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not count a path the codex profile mentions but allows', () => {
    // The whole check is a string match, so "mentioned" and "denied" have to stay distinct.
    const dir = scratchDir({
      't1.settings.json': profile(['Read(secrets/**)']),
      'codex.t1.config.toml': '[permissions.x.filesystem]\n"secrets/**" = "allow"\n',
      'codex.t1.rules': codexRules,
    });
    try {
      const finding = codexSecretsCheck(dir).find((entry) => entry.name.includes('t1'));

      expect(finding?.ok).toBe(false);
      expect(finding?.detail).toBe('codex.t1.config.toml does not deny: secrets/**');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports an unparseable claude profile as a failed finding, not a crash', () => {
    const dir = scratchDir({
      't1.settings.json': 'not json at all',
      'codex.t1.config.toml': '[permissions.x.filesystem]\n"secrets/**" = "deny"\n',
      'codex.t1.rules': codexRules,
    });
    try {
      const finding = codexSecretsCheck(dir).find((entry) => entry.name.includes('t1'));

      expect(finding?.ok).toBe(false);
      expect(finding?.detail).toContain('cannot read t1.settings.json');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says a tier ships no profile rather than inventing a requirement', () => {
    const dir = scratchDir({ 'placeholder.txt': 'x' });
    try {
      expect(codexSecretsCheck(dir).map((finding) => finding.detail)).toEqual([
        'tier 0 ships no profile',
        'tier 1 ships no profile',
        'tier 2 ships no profile',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the printed report', () => {
  const capture = (body: () => void): string[] => {
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    try {
      body();
    } finally {
      log.mockRestore();
    }
    return lines;
  };

  const emptyReport: HarnessReport = {
    findings: [],
    costs: [],
    commandCosts: [],
    echoes: [],
    commandEchoes: [],
    unclaimedDenies: [],
    scorecard: null,
  };

  it('marks each finding PASS or FAIL and prints its detail', () => {
    const lines = capture(() =>
      printReport({
        ...emptyReport,
        findings: [
          { name: 'bundle budget', ok: true, detail: 'worst case ts+none ~3000 tokens' },
          { name: 'claim rm -rf', ok: false, detail: 'no longer stated in 00-universal.md' },
        ],
      }),
    );

    expect(lines[0]).toBe('PASS  bundle budget — worst case ts+none ~3000 tokens');
    expect(lines[1]).toBe('FAIL  claim rm -rf — no longer stated in 00-universal.md');
  });

  it('prices each bundle in a fixed-width table', () => {
    const lines = capture(() =>
      printReport({
        ...emptyReport,
        costs: [
          { stack: 'ts', targets: ['workers'], chars: 12000, lines: 240, estimatedTokens: 3000 },
        ],
      }),
    );

    expect(lines[0]).toBe('\nBundle cost (layers only, project layer excluded):');
    expect(lines[1]).toBe('  ts+workers                3000 tokens  240 lines');
  });

  it('omits every optional section when there is nothing to report', () => {
    // A report padded with empty headings is one nobody reads to the bottom of.
    const lines = capture(() => printReport(emptyReport));

    expect(lines).toEqual(['\nBundle cost (layers only, project layer excluded):']);
  });

  it('counts what it lists in each optional section heading', () => {
    const lines = capture(() =>
      printReport({
        ...emptyReport,
        commandCosts: [{ name: 'conductor.md', chars: 400, lines: 12, estimatedTokens: 100 }],
        echoes: [{ line: 'never force-push', layers: ['00-universal.md', '10-security.md'] }],
        commandEchoes: [{ line: 'open a pull request', layers: ['commands/conductor.md'] }],
        unclaimedDenies: ['Bash(tofu destroy:*)'],
      }),
    );

    expect(lines).toContain('\nSlash commands (installed per repo, loaded on demand):');
    expect(lines).toContain('  conductor.md               100 tokens  12 lines');
    expect(lines).toContain('\nRules stated in more than one layer (1):');
    expect(lines).toContain('  00-universal.md + 10-security.md\n    never force-push');
    expect(lines).toContain('\nLines a command shares with a layer (1):');
    expect(lines).toContain('\nDeny rules no instruction layer explains (1):');
    expect(lines).toContain('  Bash(tofu destroy:*)');
  });
});

describe('harness-lint CLI (the exit code is the enforcement)', () => {
  /**
   * Runs the real CLI against athena's own layers. The committed scorecard is restored
   * afterwards: `main` writes it under `--write`, and a mutation run may flip that branch on.
   */
  const runCli = (): { lines: string[]; exitCode: number | string | undefined } => {
    const scorecardPath = join(athenaDir, SCORECARD_FILE);
    const committed = readFileSync(scorecardPath, 'utf8');
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const originalArgv = process.argv;
    const originalExitCode = process.exitCode;
    process.argv = ['node', 'harness-lint.ts'];
    process.exitCode = undefined;
    try {
      main();
      return { lines, exitCode: process.exitCode };
    } finally {
      process.argv = originalArgv;
      process.exitCode = originalExitCode;
      log.mockRestore();
      // Only repair it if a mutant actually flipped the --write branch. Writing
      // unconditionally would race with the parallel workers reading this same file.
      if (readFileSync(scorecardPath, 'utf8') !== committed) {
        writeFileSync(scorecardPath, committed);
      }
    }
  };

  it('leaves the exit code alone while the harness is coherent', () => {
    // If this fails, the harness is genuinely failing a check — read the printed report.
    const { lines, exitCode } = runCli();

    expect(exitCode).toBeUndefined();
    expect(lines.filter((line) => line.startsWith('FAIL'))).toEqual([]);
    expect(lines.filter((line) => line.startsWith('PASS')).length).toBeGreaterThan(10);
  });

  it('prints the cost table below the findings', () => {
    const { lines } = runCli();

    expect(lines).toContain('\nBundle cost (layers only, project layer excluded):');
    expect(lines.some((line) => line.includes('tokens'))).toBe(true);
  });

  it('does not write the scorecard without --write', () => {
    const scorecardPath = join(athenaDir, SCORECARD_FILE);
    const before = readFileSync(scorecardPath, 'utf8');

    runCli();

    expect(readFileSync(scorecardPath, 'utf8')).toBe(before);
  });
});

describe('the CLI verdict', () => {
  it('fails the run when any finding failed, and only then', () => {
    const pass = { name: 'a', ok: true, detail: '' };
    const fail = { name: 'b', ok: false, detail: '' };

    expect(anyFailed([])).toBe(false);
    expect(anyFailed([pass, pass])).toBe(false);
    expect(anyFailed([pass, fail])).toBe(true);
    expect(anyFailed([fail])).toBe(true);
  });
});

describe('rule-line normalisation', () => {
  it('strips a list marker that was hidden under emphasis', () => {
    // Regression: normalisation ran one pass, so removing the underscores exposed a `1.`
    // that then stayed in the text. The italicised rule and its plain twin normalised to
    // different strings and the duplicate went unreported.
    expect(normalizeLine('_1. Never force-push_')).toBe(normalizeLine('1. Never force-push'));
    expect(normalizeLine('_1. Never force-push_')).toBe('never force-push');
  });

  it('leaves an already-normalised line alone', () => {
    expect(normalizeLine('never force-push')).toBe('never force-push');
  });
});

describe('shipped hooks', () => {
  /** A permissions directory whose three tiers all configure the given hook commands. */
  const tiersWiringTo = (commands: string[]): string =>
    scratchDir(
      Object.fromEntries(
        ['t0', 't1', 't2'].map((tier) => [
          tier + '.settings.json',
          JSON.stringify({
            permissions: { allow: [], deny: [] },
            hooks: {
              Stop: [{ hooks: commands.map((command) => ({ type: 'command', command })) }],
            },
          }),
        ]),
      ),
    );

  it('accepts a hooks directory holding exactly what HOOKS lists', () => {
    const finding = hooksManifestCheck(join(athenaDir, 'hooks'));

    expect(finding.ok).toBe(true);
    // The detail is the whole printout for a passing run, so an empty one would make
    // `harness-lint` report a silent PASS that tells a reader nothing.
    expect(finding.detail).toBe('1 hook(s), all present');
  });

  it('reports a hook script that no manifest entry ships', () => {
    // An unlisted file looks like a working gate to anyone reading the directory, and
    // compile never installs it, so the repo it was written for silently has no such hook.
    const dir = scratchDir({ 'gate.mjs': 'exit 0\n', 'orphan.mjs': 'exit 0\n' });
    try {
      const finding = hooksManifestCheck(dir);

      expect(finding.ok).toBe(false);
      expect(finding.detail).toBe('on disk but not in HOOKS: orphan.mjs');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a manifest entry with no script behind it', () => {
    const dir = scratchDir({ 'unrelated.txt': 'not a hook\n' });
    try {
      const finding = hooksManifestCheck(dir);

      expect(finding.ok).toBe(false);
      // Named exactly, because a scan that stopped filtering by extension would call the
      // stray .txt a hook — reporting it as an orphan and still "failing" for the wrong
      // reason. Asserting the whole string is what tells those two apart.
      expect(finding.detail).toBe('in HOOKS but not on disk: gate.mjs');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts tiers whose profiles all reference every shipped hook', () => {
    const dir = tiersWiringTo(['bash /repo/.claude/hooks/gate.mjs']);
    try {
      const findings = hooksWiredCheck(dir);

      expect(findings.every((finding) => finding.ok)).toBe(true);
      expect(findings.map((finding) => finding.name)).toEqual([
        'hooks wired t0',
        'hooks wired t1',
        'hooks wired t2',
      ]);
      expect(findings[0].detail).toBe('every hook is referenced by the t0 profile');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a hook that ships but no profile ever runs', () => {
    // The failure this check exists for: a script sitting in .claude/hooks that reads like
    // enforcement while nothing invokes it. Every tier must name it, not just one.
    const dir = tiersWiringTo(['bash /repo/.claude/hooks/something-else.sh']);
    try {
      const findings = hooksWiredCheck(dir);

      expect(findings.every((finding) => !finding.ok)).toBe(true);
      expect(findings[0].detail).toBe('shipped but never run under t0: gate.mjs');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a profile carrying no hooks block at all', () => {
    // A profile predating hooks still parses, so the absent block has to read as a finding
    // rather than as an empty list that trivially satisfies the check.
    const dir = scratchDir(
      Object.fromEntries(
        ['t0', 't1', 't2'].map((tier) => [
          tier + '.settings.json',
          JSON.stringify({ permissions: { allow: [], deny: [] } }),
        ]),
      ),
    );
    try {
      expect(hooksWiredCheck(dir).every((finding) => !finding.ok)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
