import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type AthenaConfig, compile } from './compile.ts';
import { doctor } from './doctor.ts';

const athenaDir = dirname(fileURLToPath(import.meta.url));
const inputs = {
  instructionsDir: join(athenaDir, 'instructions'),
  permissionsDir: join(athenaDir, 'permissions'),
  commandsDir: join(athenaDir, 'commands'),
  projectLayer: '',
};
const valid = { athenaVersion: 'v1', stack: 'ts', targets: [], tools: ['codex'] };

describe('config validation at both entry points', () => {
  it.each([
    ['null', null],
    ['array', []],
    ['missing version', { ...valid, athenaVersion: undefined }],
    ['blank version', { ...valid, athenaVersion: ' ' }],
    ['multiline version', { ...valid, athenaVersion: 'v1\ntext' }],
    ['empty tools', { ...valid, tools: [] }],
    ['non-string tool', { ...valid, tools: [null] }],
    ['duplicate tools', { ...valid, tools: ['codex', 'codex'] }],
    ['non-string target', { ...valid, targets: [null] }],
    ['duplicate targets', { ...valid, targets: ['workers', 'workers'] }],
    ['stack path', { ...valid, stack: '../../outside' }],
    ['target path', { ...valid, targets: ['../../outside'] }],
  ])('rejects %s before compiling or checking outputs', (_name, config) => {
    expect(() => compile(config as AthenaConfig, inputs)).toThrow(/athena: invalid config/);
    const projectDir = mkdtempSync(join(tmpdir(), 'athena-config-'));
    try {
      mkdirSync(join(projectDir, '.athena'));
      writeFileSync(join(projectDir, '.athena/config.json'), JSON.stringify(config));
      const checks = doctor(projectDir, inputs.instructionsDir);
      expect(checks).toHaveLength(1);
      expect(checks[0]).toMatchObject({ name: 'config', ok: false });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
