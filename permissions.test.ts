import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readProfile } from './harness-lint.ts';

const root = dirname(fileURLToPath(import.meta.url));

describe('permission approval boundaries', () => {
  it.each(['t0', 't1', 't2'])('%s blocks direct reads of secret files', (tier) => {
    const { permissions } = readProfile(join(root, 'permissions'), tier);
    for (const path of ['**/.env', '**/.env.*', 'secrets/**']) {
      expect(permissions.deny).toContain(`Read(${path})`);
    }
  });

  it.each(['t1', 't2'])(
    '%s does not auto-approve arbitrary runner or interpreter commands',
    (tier) => {
      const { permissions } = readProfile(join(root, 'permissions'), tier);
      for (const runner of ['pnpm', 'npm', 'npx', 'node', 'uv', 'uvx', 'python']) {
        expect(permissions.allow).not.toContain(`Bash(${runner}:*)`);
      }
      expect(permissions.allow).toContain('Bash(pnpm test)');
      expect(permissions.allow).toContain('Bash(pnpm install --frozen-lockfile)');
    },
  );

  it('documents that approval rules do not isolate subprocesses', () => {
    const security = readFileSync(join(root, 'instructions/10-security.md'), 'utf8');
    expect(security).toContain('not a sandbox');
  });
});
