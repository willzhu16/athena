import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type AcknowledgedDeny,
  BUNDLE_TOKEN_BUDGET,
  type BundleCost,
  bashCommand,
  budgetCheck,
  bundleCosts,
  type CoherenceClaim,
  claimChecks,
  denySoundnessChecks,
  duplicateCheck,
  duplicateLines,
  harnessLint,
  isOrderSensitive,
  readProfile,
  unsoundDenies,
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
