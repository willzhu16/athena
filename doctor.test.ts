import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildBody, computeHash } from './compile.ts';
import { doctor, isFresh, sameJson } from './doctor.ts';

const body = '# Layer\n\nreal content\n';
const hash = computeHash(body);
const compiled = `<!-- ATHENA-COMPILED v1 sha:${hash} — do not edit -->\n\n${body}`;

describe('isFresh (drift detection)', () => {
  it('accepts an unmodified compiled file', () => {
    expect(isFresh(compiled, hash)).toBe(true);
  });

  it('rejects a hand-edit below the header', () => {
    // Regression: the header hash stays valid, so trusting it (the old bug) read as fresh.
    const edited = `${compiled}\nsneaky hand edit\n`;
    expect(isFresh(edited, hash)).toBe(false);
  });

  it('rejects stale content when the source layers have changed', () => {
    expect(isFresh(compiled, 'deadbeefdeadbeef')).toBe(false);
  });
});

describe('doctor (config problems become failed checks, never crashes)', () => {
  const athenaDir = dirname(fileURLToPath(import.meta.url));
  const instructionsDir = join(athenaDir, 'instructions');

  it('reports a stack whose instruction layer does not exist as a failed check', () => {
    // Regression: doctor used to throw here (e.g. the py-tool template's old stack "py",
    // which resolves to the nonexistent layer 20-stack-py.md) instead of reporting.
    const projectDir = mkdtempSync(join(tmpdir(), 'athena-doctor-'));
    try {
      mkdirSync(join(projectDir, '.athena'), { recursive: true });
      writeFileSync(
        join(projectDir, '.athena', 'config.json'),
        JSON.stringify({
          athenaVersion: 'v1',
          stack: 'no-such-stack',
          targets: [],
          tools: ['codex'],
        }),
      );

      const checks = doctor(projectDir, instructionsDir);
      const layersCheck = checks.find((check) => check.name === 'layers');

      expect(layersCheck?.ok).toBe(false);
      expect(layersCheck?.detail).toContain('20-stack-no-such-stack.md');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('reports a config naming an unknown tool as a failed check (parity with compile)', () => {
    // Regression: doctor greenlit tools:["claud"] with an all-PASS report — the typo
    // disabled every instruction-file check — while compile rejected the same config.
    const projectDir = mkdtempSync(join(tmpdir(), 'athena-doctor-'));
    try {
      mkdirSync(join(projectDir, '.athena'), { recursive: true });
      writeFileSync(
        join(projectDir, '.athena', 'config.json'),
        JSON.stringify({ athenaVersion: 'v1', stack: 'ts', targets: [], tools: ['claud'] }),
      );

      const checks = doctor(projectDir, instructionsDir);

      expect(checks).toHaveLength(1);
      expect(checks[0]?.ok).toBe(false);
      expect(checks[0]?.detail).toContain('unknown tool');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('reports an unreadable settings profile as a failed check instead of throwing', () => {
    // Regression: a permissionsDir without t1.settings.json threw ENOENT out of doctor().
    const projectDir = mkdtempSync(join(tmpdir(), 'athena-doctor-'));
    try {
      mkdirSync(join(projectDir, '.athena'), { recursive: true });
      mkdirSync(join(projectDir, '.claude'), { recursive: true });
      writeFileSync(
        join(projectDir, '.athena', 'config.json'),
        JSON.stringify({ athenaVersion: 'v1', stack: 'ts', targets: [], tools: ['claude'] }),
      );
      writeFileSync(join(projectDir, '.claude', 'settings.json'), '{}\n');

      const checks = doctor(projectDir, instructionsDir, join(projectDir, 'no-such-dir'));
      const settingsCheck = checks.find((check) => check.name === '.claude/settings.json');

      expect(settingsCheck?.ok).toBe(false);
      expect(settingsCheck?.detail).toContain('cannot read expected source');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('still runs the hash-independent checks when the layer build fails', () => {
    // Regression: doctor returned early after the layers FAIL, hiding the settings and
    // task.yml state until the stack was fixed — one remediation pass became several.
    const projectDir = mkdtempSync(join(tmpdir(), 'athena-doctor-'));
    try {
      mkdirSync(join(projectDir, '.athena'), { recursive: true });
      writeFileSync(
        join(projectDir, '.athena', 'config.json'),
        JSON.stringify({
          athenaVersion: 'v1',
          stack: 'no-such-stack',
          targets: [],
          tools: ['claude'],
        }),
      );

      const checks = doctor(projectDir, instructionsDir);
      const names = checks.map((check) => check.name);

      expect(names).toContain('layers');
      expect(names).toContain('.claude/settings.json');
      expect(names).toContain('.github/ISSUE_TEMPLATE/task.yml');
      expect(names).not.toContain('CLAUDE.md');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('reports a config whose tools field is not an array as a failed check', () => {
    // Regression: doctor used to throw a TypeError on config.tools.join.
    const projectDir = mkdtempSync(join(tmpdir(), 'athena-doctor-'));
    try {
      mkdirSync(join(projectDir, '.athena'), { recursive: true });
      writeFileSync(
        join(projectDir, '.athena', 'config.json'),
        JSON.stringify({ athenaVersion: 'v1', stack: 'ts', targets: [], tools: 'claude' }),
      );

      const checks = doctor(projectDir, instructionsDir);

      expect(checks).toHaveLength(1);
      expect(checks[0]?.ok).toBe(false);
      expect(checks[0]?.detail).toContain('"tools" must be an array');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe('doctor', () => {
  it('rejects a settings file that does not match the expected permission profile', () => {
    const athenaDir = dirname(fileURLToPath(import.meta.url));
    const instructionsDir = join(athenaDir, 'instructions');
    const permissionsDir = join(athenaDir, 'permissions');
    const projectDir = mkdtempSync(join(tmpdir(), 'athena-doctor-'));

    try {
      mkdirSync(join(projectDir, '.athena'), { recursive: true });
      mkdirSync(join(projectDir, '.claude'), { recursive: true });
      mkdirSync(join(projectDir, '.github', 'ISSUE_TEMPLATE'), { recursive: true });

      writeFileSync(
        join(projectDir, '.athena', 'config.json'),
        JSON.stringify(
          {
            athenaVersion: 'v1',
            stack: 'ts',
            targets: ['workers'],
            tools: ['claude'],
          },
          null,
          2,
        ),
      );

      const body = buildBody(
        {
          athenaVersion: 'v1',
          stack: 'ts',
          targets: ['workers'],
          tools: ['claude'],
        },
        instructionsDir,
        '',
      );
      const expectedHash = computeHash(body);
      writeFileSync(
        join(projectDir, 'CLAUDE.md'),
        `<!-- ATHENA-COMPILED v1 sha:${expectedHash} — do not edit -->\n\n${body}`,
      );
      writeFileSync(join(projectDir, '.claude', 'settings.json'), '{"bad": true}\n');
      writeFileSync(join(projectDir, '.github', 'ISSUE_TEMPLATE', 'task.yml'), '---\n');

      const checks = doctor(projectDir, instructionsDir, permissionsDir);
      const settingsCheck = checks.find((check) => check.name === '.claude/settings.json');

      expect(settingsCheck?.ok).toBe(false);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('reports a hand-edited conductor command as drift', () => {
    // The command ships verbatim like the settings profile, so a local edit must read as
    // drift instead of quietly becoming that repo's private version of the pattern.
    const athenaDir = dirname(fileURLToPath(import.meta.url));
    const instructionsDir = join(athenaDir, 'instructions');
    const projectDir = mkdtempSync(join(tmpdir(), 'athena-doctor-'));

    try {
      mkdirSync(join(projectDir, '.athena'), { recursive: true });
      mkdirSync(join(projectDir, '.claude', 'commands'), { recursive: true });
      writeFileSync(
        join(projectDir, '.athena', 'config.json'),
        JSON.stringify({ athenaVersion: 'v1', stack: 'ts', targets: [], tools: ['claude'] }),
      );
      writeFileSync(
        join(projectDir, '.claude', 'commands', 'conductor.md'),
        '# not the shipped command\n',
      );

      const check = doctor(projectDir, instructionsDir).find(
        (candidate) => candidate.name === '.claude/commands/conductor.md',
      );

      expect(check?.ok).toBe(false);
      expect(check?.detail).toContain('content differs');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe('sameJson (settings drift compares meaning, not bytes)', () => {
  const profile =
    '{\n  "permissions": {\n    "allow": ["Read"],\n    "deny": ["Bash(rm:*)"]\n  }\n}\n';

  it('accepts a file that only differs in whitespace', () => {
    // Regression: the check was byte-exact, so an editor reindenting the settings file, or
    // a Windows tool rewriting its line endings, read as tampering.
    expect(sameJson('{"permissions":{"allow":["Read"],"deny":["Bash(rm:*)"]}}', profile)).toBe(
      true,
    );
  });

  it('accepts a file whose object keys are in a different order', () => {
    const reordered = '{"permissions":{"deny":["Bash(rm:*)"],"allow":["Read"]}}';
    expect(sameJson(reordered, profile)).toBe(true);
  });

  it('rejects a file with a rule removed', () => {
    expect(sameJson('{"permissions":{"allow":["Read"],"deny":[]}}', profile)).toBe(false);
  });

  it('rejects a file with an extra rule', () => {
    const extra = '{"permissions":{"allow":["Read","Write"],"deny":["Bash(rm:*)"]}}';
    expect(sameJson(extra, profile)).toBe(false);
  });

  it('rejects a reordered permission list, because order is not incidental', () => {
    const swapped = '{"permissions":{"allow":["Read"],"deny":["Bash(rm:*)","Bash(x:*)"]}}';
    const original = '{"permissions":{"allow":["Read"],"deny":["Bash(x:*)","Bash(rm:*)"]}}';
    expect(sameJson(swapped, original)).toBe(false);
  });

  it('reports null for a file that is not JSON, so the caller keeps the byte result', () => {
    expect(sameJson('not json at all', profile)).toBeNull();
  });
});
