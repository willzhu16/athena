import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  type AthenaConfig,
  buildBody,
  compile,
  computeHash,
  extractBody,
  HOOKS,
  main,
  readDeclaredHash,
  resolveLayers,
  SKILLS,
  validateConfig,
  writeOutputs,
} from './compile.ts';

const athenaDir = dirname(fileURLToPath(import.meta.url));
const instructionsDir = join(athenaDir, 'instructions');
const permissionsDir = join(athenaDir, 'permissions');
const commandsDir = join(athenaDir, 'commands');
const hooksDir = join(athenaDir, 'hooks');
const skillsDir = join(athenaDir, 'skills');

const config: AthenaConfig = {
  athenaVersion: 'v1',
  stack: 'ts',
  targets: ['workers'],
  tools: ['claude', 'codex'],
  review: { enabled: false, reviewer: 'claude' },
};
const projectLayer = '# Project layer\n\nProject-specific note.\n';
const inputs = {
  instructionsDir,
  permissionsDir,
  commandsDir,
  hooksDir,
  skillsDir,
  projectLayer,
};

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

  it('installs the conductor command verbatim for the claude tool', () => {
    // The pattern is only reachable if it ships as a command; a process doc in the athena
    // repo is not something an agent working in a generated repo will ever find.
    const { files } = compile(config, inputs);
    expect(files['.claude/commands/conductor.md']).toBe(
      readFileSync(join(commandsDir, 'conductor.md'), 'utf8'),
    );
  });

  it('installs the gate hook verbatim for the claude tool', () => {
    // The layers can ask for a green gate; only the hook makes "done" mean it actually ran.
    // Shipping it byte-for-byte is what lets doctor call a weakened copy drift later.
    const { files } = compile(config, inputs);

    expect(files['.claude/hooks/gate.mjs']).toBe(readFileSync(join(hooksDir, 'gate.mjs'), 'utf8'));
  });

  it('installs each skill at the path Claude Code looks for', () => {
    // .claude/skills/<name>/SKILL.md is the only layout Claude Code discovers. A skill
    // written to any other path ships bytes nothing will ever read.
    const { files } = compile(config, inputs);

    for (const skill of SKILLS) {
      expect(files[`.claude/skills/${skill}/SKILL.md`]).toBe(
        readFileSync(join(skillsDir, skill, 'SKILL.md'), 'utf8'),
      );
    }
  });

  it('wires every shipped hook into the installed permission profile', () => {
    // A hook file nobody references is a dead script that reads like a gate. The profile
    // must name each one, or compile is shipping reassurance rather than enforcement.
    const { files } = compile(config, inputs);
    const settings = files['.claude/settings.json'];

    for (const hook of HOOKS) {
      expect(settings).toContain(`.claude/hooks/${hook}`);
    }
  });

  it('ships no claude commands or settings to a codex-only project', () => {
    // Codex now gets its own profile, but none of the Claude surface: no CLAUDE.md, no
    // .claude/settings.json, no slash commands.
    const { files } = compile({ ...config, tools: ['codex'] }, inputs);

    expect(Object.keys(files).sort()).toEqual([
      '.codex/config.toml',
      '.codex/rules/artemis.rules',
      'AGENTS.md',
    ]);
  });

  it('carries a footer hash that matches the compiled body', () => {
    const { files, hash } = compile(config, inputs);
    const claude = files['CLAUDE.md'];
    expect(readDeclaredHash(claude)).toBe(hash);
    expect(computeHash(extractBody(claude))).toBe(hash);
  });

  it('reads no hash out of a file that was never compiled', () => {
    // doctor reads null as "not an athena artifact" and falls back to a presence check.
    // Any other answer would report a hand-written CLAUDE.md as drifted.
    expect(readDeclaredHash('# CLAUDE.md\n\nhand-written, no header\n')).toBeNull();
  });

  it('ships the T1 permission profile for the claude tool', () => {
    const { files } = compile(config, inputs);
    const expected = readFileSync(join(permissionsDir, 't1.settings.json'), 'utf8');
    expect(files['.claude/settings.json']).toBe(expected);
  });

  it('rejects an unknown tool in config.tools instead of silently falling back', () => {
    // Regression: a typo like "claud" used to compile "successfully" into the generic
    // athena-system-prompt.md, leaving the repo with no CLAUDE.md and no error.
    const typoConfig: AthenaConfig = { ...config, tools: ['claud'] };
    expect(() => compile(typoConfig, inputs)).toThrow('unknown tool "claud"');
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

describe('codex outputs', () => {
  it('installs the codex permission profile alongside AGENTS.md', () => {
    // Regression: tool `codex` produced instructions and nothing else, so every generated
    // repo enforced rules for one agent and merely stated them for the other.
    const { files } = compile(config, inputs);
    const expected = readFileSync(join(permissionsDir, 'codex.t1.config.toml'), 'utf8');

    expect(files['.codex/config.toml']).toBe(expected);
  });

  it('emits no codex files when codex is not a configured tool', () => {
    const { files } = compile({ ...config, tools: ['claude'] }, inputs);

    expect(Object.keys(files).some((name) => name.startsWith('.codex/'))).toBe(false);
  });
});

describe('permission tiers', () => {
  it('installs t1 when no tier is named, so existing repos do not drift', () => {
    // The whole point of DEFAULT_TIER: before tiers existed every repo got t1, and adding
    // the field must not change a single already-generated file.
    const { files } = compile(config, inputs);
    const t1 = readFileSync(join(permissionsDir, 't1.settings.json'), 'utf8');

    expect(files['.claude/settings.json']).toBe(t1);
  });

  it.each([0, 2])('installs the t%d profile when the config asks for it', (tier) => {
    const { files } = compile({ ...config, tier, tools: ['claude'] }, inputs);
    const expected = readFileSync(join(permissionsDir, `t${tier}.settings.json`), 'utf8');

    expect(files['.claude/settings.json']).toBe(expected);
  });

  it('names a missing profile instead of falling back to another tier', () => {
    // All three tiers ship both profiles today, so this points compile at a permissions
    // directory holding only t1. Silently installing t1 under a tier that promised
    // something stricter is the failure this guard exists to prevent.
    const bare = mkdtempSync(join(tmpdir(), 'athena-perms-'));
    try {
      writeFileSync(join(bare, 't1.settings.json'), '{}');

      expect(() =>
        compile({ ...config, tier: 0, tools: ['claude'] }, { ...inputs, permissionsDir: bare }),
      ).toThrow('permission profile not found: t0.settings.json');
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it.each([3, -1, '1', null])('rejects %p as a tier', (tier) => {
    expect(() => compile({ ...config, tier } as never, inputs)).toThrow('unknown tier');
  });
});

describe('codex command rules', () => {
  it('installs the tier rules file alongside the codex config', () => {
    // Codex splits file access and command policy across two files, so one Claude profile
    // maps onto two Codex outputs. Shipping only the config enforces half the profile.
    const { files } = compile(config, inputs);
    const expected = readFileSync(join(permissionsDir, 'codex.t1.rules'), 'utf8');

    expect(files['.codex/rules/artemis.rules']).toBe(expected);
  });

  it.each([0, 2])('installs the t%d rules for that tier', (tier) => {
    const { files } = compile({ ...config, tier, tools: ['codex'] }, inputs);
    const expected = readFileSync(join(permissionsDir, `codex.t${tier}.rules`), 'utf8');

    expect(files['.codex/rules/artemis.rules']).toBe(expected);
  });

  it('forbids preview deploys at tier 1 and permits them at tier 2', () => {
    // This is the whole difference between the two tiers, and it lives in the rules file
    // rather than the config. Asserted on content so a future edit cannot quietly erase it.
    const t1 = readFileSync(join(permissionsDir, 'codex.t1.rules'), 'utf8');
    const t2 = readFileSync(join(permissionsDir, 'codex.t2.rules'), 'utf8');

    expect(t1).toContain('pattern = ["wrangler", "versions"]');
    expect(t2).toContain('pattern = ["wrangler", "versions", "deploy"]');
    expect(t2).not.toContain('pattern = ["wrangler", "pages", "deploy"]');
  });

  it('records the force-push prefix gap as a tested not_match', () => {
    // The hole is real in Codex exactly as in Claude. Writing it down means nobody mistakes
    // the rule for airtight, and Codex refuses to load the file if it stops being true.
    const t1 = readFileSync(join(permissionsDir, 'codex.t1.rules'), 'utf8');

    expect(t1).toContain('"git push origin main --force"');
  });
});

describe('config validation (the message is the whole user interface)', () => {
  // `.athena/config.json` is hand-edited and hand-copied between repos, so a rejection has
  // to name the field that is wrong. These assert the exact text: a message that only says
  // "invalid config" sends someone back to read the compiler source.
  const valid: Record<string, unknown> = {
    athenaVersion: 'v1',
    stack: 'ts',
    targets: ['workers'],
    tools: ['claude'],
  };

  const rejects = (config: unknown, detail: string): void => {
    expect(() => validateConfig(config)).toThrow(`athena: invalid config — ${detail}`);
  };

  it('accepts the shape every generated repo ships', () => {
    expect(() => validateConfig(valid)).not.toThrow();
    expect(() => validateConfig({ ...valid, tier: 2 })).not.toThrow();
    expect(() => validateConfig({ ...valid, targets: [] })).not.toThrow();
  });

  it('rejects anything that is not a plain object', () => {
    for (const value of [null, 'a string', 42, ['ts']]) {
      rejects(value, 'must be an object');
    }
  });

  it('rejects an athenaVersion that would break the compiled header', () => {
    // It is interpolated straight into an HTML comment, so whitespace and angle brackets
    // are the characters that could end the comment early.
    for (const athenaVersion of [undefined, 1, '', 'v 1', 'v1<']) {
      rejects({ ...valid, athenaVersion }, '"athenaVersion" must be a non-empty header token');
    }
  });

  it('rejects a stack that is not a layer identifier', () => {
    // The value becomes a filename, so it is anchored at both ends: a trailing-garbage
    // stack that matched only its prefix would resolve to a layer nobody named.
    for (const stack of [undefined, 42, '', 'TS', 'ts workers', 'ts/../etc']) {
      rejects({ ...valid, stack }, '"stack" must be a layer identifier');
    }
  });

  it('rejects a targets field that is not a list', () => {
    rejects({ ...valid, targets: 'workers' }, '"targets" must be an array');
  });

  it('rejects target entries that are not layer identifiers', () => {
    for (const targets of [[42], ['Workers'], ['workers extra'], ['']]) {
      rejects({ ...valid, targets }, '"targets" must contain layer identifiers');
    }
  });

  it('rejects a repeated target, which would load the same layer twice', () => {
    rejects({ ...valid, targets: ['workers', 'workers'] }, '"targets" must be unique');
  });

  it('rejects a tools field that is not a list', () => {
    rejects({ ...valid, tools: 'claude' }, '"tools" must be an array');
  });

  it('rejects an empty tools list, which would compile nothing at all', () => {
    rejects({ ...valid, tools: [] }, '"tools" must contain at least one tool');
  });

  it('names the unknown tool and the ones it knows', () => {
    rejects({ ...valid, tools: ['claud'] }, 'unknown tool "claud" — known tools: claude, codex');
    rejects({ ...valid, tools: [7] }, 'unknown tool "7" — known tools: claude, codex');
  });

  it('rejects a repeated tool', () => {
    rejects({ ...valid, tools: ['claude', 'claude'] }, '"tools" must be unique');
  });

  it('names the unknown tier and the ones it knows', () => {
    rejects({ ...valid, tier: 9 }, 'unknown tier "9" — known tiers: 0, 1, 2');
    rejects({ ...valid, tier: '1' }, 'unknown tier "1" — known tiers: 0, 1, 2');
  });
});

describe('the compiled header (a frozen contract, D-18)', () => {
  it('is one line naming the marker, the version, the hash and where to edit instead', () => {
    // doctor parses this line and every generated repo carries it. Changing its shape is a
    // breaking change across the fleet, so the exact text is pinned here rather than
    // described loosely.
    const config: AthenaConfig = {
      athenaVersion: 'v1',
      stack: 'ts',
      targets: [],
      tools: ['claude'],
    };
    const outputs = compile(config, {
      instructionsDir,
      permissionsDir,
      commandsDir,
      hooksDir,
      skillsDir,
      projectLayer: '',
    });

    expect(outputs.files['CLAUDE.md']?.split('\n')[0]).toBe(
      `<!-- ATHENA-COMPILED v1 sha:${outputs.hash} — ` +
        'edit .athena/project.md or the athena repo, never this file -->',
    );
  });

  it('returns the whole text when there is no header to strip', () => {
    // A file with no blank line after the header has no body boundary; returning the whole
    // string keeps the hash comparison honest instead of silently dropping a character.
    expect(extractBody('no header at all')).toBe('no header at all');
    expect(extractBody('header line\n\nbody text\n')).toBe('body text\n');
  });
});

describe('writeOutputs', () => {
  it('returns every relative path it wrote', () => {
    // The return value is what the CLI prints, and the only record of what a compile run
    // touched in someone else's repo.
    const config: AthenaConfig = {
      athenaVersion: 'v1',
      stack: 'ts',
      targets: [],
      tools: ['claude', 'codex'],
    };
    const outputs = compile(config, {
      instructionsDir,
      permissionsDir,
      commandsDir,
      hooksDir,
      skillsDir,
      projectLayer: '',
    });
    const projectDir = mkdtempSync(join(tmpdir(), 'athena-compile-'));
    try {
      const written = writeOutputs(projectDir, outputs);

      expect([...written].sort()).toEqual(Object.keys(outputs.files).sort());
      expect(written).toContain('.claude/commands/conductor.md');
      for (const relative of written) {
        expect(readFileSync(join(projectDir, relative), 'utf8')).toBe(outputs.files[relative]);
      }
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe('compile CLI', () => {
  it('compiles the project named on the command line and reports what it wrote', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'athena-compile-'));
    const originalArgv = process.argv;
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    try {
      mkdirSync(join(projectDir, '.athena'), { recursive: true });
      writeFileSync(
        join(projectDir, '.athena', 'config.json'),
        JSON.stringify({ athenaVersion: 'v1', stack: 'ts', targets: [], tools: ['claude'] }),
      );
      writeFileSync(join(projectDir, '.athena', 'project.md'), '# Project\n\nship on Fridays\n');
      process.argv = ['node', 'compile.ts', projectDir];

      main();

      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(
        /^athena: compiled 7 file\(s\) \[sha:[0-9a-f]{16}\] -> CLAUDE\.md, \.claude\/settings\.json, \.claude\/commands\/conductor\.md, \.claude\/hooks\/gate\.mjs, \.claude\/skills\/review-protocol\/SKILL\.md, \.claude\/skills\/verify-change\/SKILL\.md, \.claude\/skills\/write-a-packet\/SKILL\.md$/,
      );
      // The project layer has to reach the compiled file, or a repo's own rules are the one
      // part of the harness that never ships.
      expect(readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8')).toContain('ship on Fridays');
    } finally {
      process.argv = originalArgv;
      log.mockRestore();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('compiles a project that has not written a project layer', () => {
    // .athena/project.md is optional: a freshly scaffolded repo has none yet, and it has to
    // compile to exactly what an empty project layer produces rather than fail on ENOENT.
    const projectDir = mkdtempSync(join(tmpdir(), 'athena-compile-'));
    const originalArgv = process.argv;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bare: AthenaConfig = { athenaVersion: 'v1', stack: 'ts', targets: [], tools: ['claude'] };
    try {
      mkdirSync(join(projectDir, '.athena'), { recursive: true });
      writeFileSync(join(projectDir, '.athena', 'config.json'), JSON.stringify(bare));
      process.argv = ['node', 'compile.ts', projectDir];

      main();

      const expected = compile(bare, { ...inputs, projectLayer: '' }).files['CLAUDE.md'];
      expect(readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8')).toBe(expected);
    } finally {
      process.argv = originalArgv;
      log.mockRestore();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('compiles the working directory when no path is given', () => {
    // How athena-sync runs it: cd into the repo, then `athena compile` with no argument.
    // Defaulting to the wrong directory would write a repo's rules into someone else's.
    // cwd is stubbed rather than really changed, because the mutation runner's test workers
    // cannot chdir.
    const projectDir = mkdtempSync(join(tmpdir(), 'athena-compile-'));
    const originalArgv = process.argv;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    try {
      mkdirSync(join(projectDir, '.athena'), { recursive: true });
      writeFileSync(
        join(projectDir, '.athena', 'config.json'),
        JSON.stringify({ athenaVersion: 'v1', stack: 'ts', targets: [], tools: ['claude'] }),
      );
      writeFileSync(join(projectDir, '.athena', 'project.md'), '# Project\n\nno argument\n');
      process.argv = ['node', 'compile.ts'];

      main();

      expect(readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8')).toContain('no argument');
    } finally {
      process.argv = originalArgv;
      cwd.mockRestore();
      log.mockRestore();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
