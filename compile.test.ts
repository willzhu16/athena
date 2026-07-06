import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type AthenaConfig,
  buildBody,
  compile,
  computeHash,
  extractBody,
  readDeclaredHash,
  resolveLayers,
} from './compile.ts';

const athenaDir = dirname(fileURLToPath(import.meta.url));
const instructionsDir = join(athenaDir, 'instructions');
const permissionsDir = join(athenaDir, 'permissions');

const config: AthenaConfig = {
  athenaVersion: 'v1',
  stack: 'ts',
  targets: ['workers'],
  tools: ['claude', 'codex'],
  review: { enabled: false, reviewer: 'claude' },
};
const projectLayer = '# Project layer\n\nProject-specific note.\n';
const inputs = { instructionsDir, permissionsDir, projectLayer };

describe('resolveLayers', () => {
  it('orders layers by numeric prefix with targets after the stack', () => {
    expect(resolveLayers(config)).toEqual([
      '00-universal.md',
      '10-security.md',
      '20-stack-ts.md',
      '30-target-workers.md',
    ]);
  });
});

describe('compile', () => {
  it('is deterministic: identical inputs produce identical output', () => {
    expect(compile(config, inputs)).toEqual(compile(config, inputs));
  });

  it('emits matching CLAUDE.md and AGENTS.md bodies', () => {
    const { files } = compile(config, inputs);
    expect(files['CLAUDE.md']).toBe(files['AGENTS.md']);
  });

  it('carries a footer hash that matches the compiled body', () => {
    const { files, hash } = compile(config, inputs);
    const claude = files['CLAUDE.md'];
    expect(readDeclaredHash(claude)).toBe(hash);
    expect(computeHash(extractBody(claude))).toBe(hash);
  });

  it('ships the T1 permission profile for the claude tool', () => {
    const { files } = compile(config, inputs);
    const expected = readFileSync(join(permissionsDir, 't1.settings.json'), 'utf8');
    expect(files['.claude/settings.json']).toBe(expected);
  });

  it('merges layers in order with the project layer last', () => {
    const body = buildBody(config, instructionsDir, projectLayer);
    const order = [
      '# Universal working rules',
      '# Security rules for agents',
      '# TypeScript conventions',
      '# Cloudflare Workers target',
      '# Project layer',
    ];
    const positions = order.map((heading) => body.indexOf(heading));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((first, second) => first - second));
  });
});
