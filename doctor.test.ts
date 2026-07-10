import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildBody, computeHash } from './compile.ts';
import { doctor, isFresh } from './doctor.ts';

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
        JSON.stringify({ athenaVersion: 'v1', stack: 'no-such-stack', targets: [], tools: [] }),
      );

      const checks = doctor(projectDir, instructionsDir);
      const layersCheck = checks.find((check) => check.name === 'layers');

      expect(layersCheck?.ok).toBe(false);
      expect(layersCheck?.detail).toContain('20-stack-no-such-stack.md');
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
});
