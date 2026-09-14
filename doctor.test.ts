import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { type AthenaConfig, buildBody, compile, computeHash, writeOutputs } from './compile.ts';
import { canonicalJson, doctor, isFresh, main, sameJson } from './doctor.ts';

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

const athenaRoot = dirname(fileURLToPath(import.meta.url));

/**
 * Build a project the way `athena compile` really builds one, so the passing path under test
 * is the shipped path rather than a hand-assembled imitation. task.yml comes from the copier
 * template, not from compile, so it is written here.
 */
const buildProject = (projectDir: string, config: AthenaConfig, projectLayer = ''): void => {
  mkdirSync(join(projectDir, '.athena'), { recursive: true });
  writeFileSync(join(projectDir, '.athena', 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  if (projectLayer !== '') {
    writeFileSync(join(projectDir, '.athena', 'project.md'), projectLayer);
  }
  writeOutputs(
    projectDir,
    compile(config, {
      instructionsDir: join(athenaRoot, 'instructions'),
      permissionsDir: join(athenaRoot, 'permissions'),
      commandsDir: join(athenaRoot, 'commands'),
      projectLayer,
    }),
  );
  mkdirSync(join(projectDir, '.github', 'ISSUE_TEMPLATE'), { recursive: true });
  writeFileSync(join(projectDir, '.github', 'ISSUE_TEMPLATE', 'task.yml'), 'name: task\n');
};

const withProject = (
  config: AthenaConfig,
  assert: (projectDir: string) => void,
  projectLayer = '',
): void => {
  const projectDir = mkdtempSync(join(tmpdir(), 'athena-doctor-'));
  try {
    buildProject(projectDir, config, projectLayer);
    assert(projectDir);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
};

const run = (projectDir: string) => doctor(projectDir, join(athenaRoot, 'instructions'));

const bothTools: AthenaConfig = {
  athenaVersion: 'v1',
  stack: 'ts',
  targets: ['workers'],
  tools: ['claude', 'codex'],
};

/**
 * Every other doctor test builds a broken repo and asserts one check fails. That leaves the
 * passing path untested, and mutation testing showed what it costs: doctor could be rewritten
 * to call every file missing, or to call a missing permission profile PASS, with the whole
 * suite still green. These pin the other direction.
 */
describe('doctor (a correctly compiled repo passes every check)', () => {
  it('passes every check right after compile, for both tools', () => {
    withProject(bothTools, (projectDir) => {
      const checks = run(projectDir);

      expect(checks.map((check) => check.name)).toEqual([
        'config',
        'CLAUDE.md',
        '.claude/settings.json',
        '.claude/commands/conductor.md',
        '.codex/config.toml',
        '.codex/rules/artemis.rules',
        'AGENTS.md',
        '.github/ISSUE_TEMPLATE/task.yml',
      ]);
      expect(checks.filter((check) => !check.ok)).toEqual([]);
    });
  });

  it('reports what it verified, not just that it passed', () => {
    // The detail line is the whole product of a doctor run: a PASS with an empty or wrong
    // reason is what a drift report looks like when nobody reads it.
    withProject(bothTools, (projectDir) => {
      const detail = (name: string) => run(projectDir).find((check) => check.name === name)?.detail;

      expect(detail('config')).toBe('stack=ts tier=1 tools=claude,codex');
      expect(detail('CLAUDE.md')).toMatch(/^fresh \(sha:[0-9a-f]{16}\)$/);
      expect(detail('AGENTS.md')).toMatch(/^fresh \(sha:[0-9a-f]{16}\)$/);
      expect(detail('.claude/settings.json')).toBe('matches the t1 profile');
      expect(detail('.claude/commands/conductor.md')).toBe('matches the conductor command');
      expect(detail('.codex/config.toml')).toBe('matches the codex t1 profile');
      expect(detail('.codex/rules/artemis.rules')).toBe('matches the codex t1 command rules');
      expect(detail('.github/ISSUE_TEMPLATE/task.yml')).toBe('present');
    });
  });

  it('checks only the files the configured tools own', () => {
    withProject({ ...bothTools, tools: ['claude'] }, (projectDir) => {
      const names = run(projectDir).map((check) => check.name);
      expect(names).toContain('CLAUDE.md');
      expect(names).not.toContain('AGENTS.md');
      expect(names).not.toContain('.codex/config.toml');
      expect(names).not.toContain('.codex/rules/artemis.rules');
    });

    withProject({ ...bothTools, tools: ['codex'] }, (projectDir) => {
      const names = run(projectDir).map((check) => check.name);
      expect(names).toContain('AGENTS.md');
      expect(names).toContain('.codex/config.toml');
      expect(names).not.toContain('CLAUDE.md');
      expect(names).not.toContain('.claude/settings.json');
    });
  });
});

describe('doctor (a deleted file is drift, not an absence to shrug at)', () => {
  const missingDetail = 'missing — run `athena compile`';

  it('fails when the permission profile has been deleted', () => {
    // The tampering this most resembles: removing the wall rather than editing it.
    withProject(bothTools, (projectDir) => {
      rmSync(join(projectDir, '.claude', 'settings.json'));
      const check = run(projectDir).find((candidate) => candidate.name === '.claude/settings.json');

      expect(check?.ok).toBe(false);
      expect(check?.detail).toBe(missingDetail);
    });
  });

  it('fails when a compiled instruction file has been deleted', () => {
    withProject(bothTools, (projectDir) => {
      rmSync(join(projectDir, 'CLAUDE.md'));
      const check = run(projectDir).find((candidate) => candidate.name === 'CLAUDE.md');

      expect(check?.ok).toBe(false);
      expect(check?.detail).toBe(missingDetail);
    });
  });

  it('fails when the task-packet template has been deleted', () => {
    withProject(bothTools, (projectDir) => {
      rmSync(join(projectDir, '.github', 'ISSUE_TEMPLATE', 'task.yml'));
      const check = run(projectDir).find(
        (candidate) => candidate.name === '.github/ISSUE_TEMPLATE/task.yml',
      );

      expect(check?.ok).toBe(false);
      expect(check?.detail).toBe('missing');
    });
  });

  it('reports both hashes when a compiled file is hand-edited', () => {
    withProject(bothTools, (projectDir) => {
      const path = join(projectDir, 'CLAUDE.md');
      writeFileSync(path, `${readFileSync(path, 'utf8')}\nsneaky hand edit\n`);
      const check = run(projectDir).find((candidate) => candidate.name === 'CLAUDE.md');

      expect(check?.ok).toBe(false);
      expect(check?.detail).toMatch(
        /^drift: content sha:[0-9a-f]{16} != expected sha:[0-9a-f]{16}$/,
      );
    });
  });
});

describe('doctor (the project layer is part of what is hashed)', () => {
  it('fails when .athena/project.md is edited without recompiling', () => {
    // Regression: doctor read the project layer, but nothing proved it. Ignoring the file
    // would leave every repo-specific rule outside drift detection — editable at will, with
    // doctor still reporting fresh.
    withProject(
      bothTools,
      (projectDir) => {
        writeFileSync(join(projectDir, '.athena', 'project.md'), '# Project\n\nrewritten\n');
        const checks = run(projectDir);

        expect(checks.find((check) => check.name === 'CLAUDE.md')?.ok).toBe(false);
        expect(checks.find((check) => check.name === 'AGENTS.md')?.ok).toBe(false);
      },
      '# Project\n\nthis repo deploys on Fridays\n',
    );
  });

  it('passes when the project layer is present and unchanged', () => {
    withProject(
      bothTools,
      (projectDir) => {
        expect(run(projectDir).filter((check) => !check.ok)).toEqual([]);
      },
      '# Project\n\nthis repo deploys on Fridays\n',
    );
  });
});

describe('canonicalJson (the canonical form itself, not just what compares equal)', () => {
  it('sorts object keys', () => {
    // Asserted on the output rather than through sameJson: comparing two documents cannot
    // tell a correct sort from a consistently wrong one, since both sides get the same order.
    expect(canonicalJson(JSON.parse('{"deny":1,"allow":2,"ask":3}'))).toBe(
      '{"allow":2,"ask":3,"deny":1}',
    );
  });

  it('keeps array order', () => {
    expect(canonicalJson(['b', 'a'])).toBe('["b","a"]');
  });

  it('sorts keys at every depth', () => {
    expect(canonicalJson(JSON.parse('{"b":{"d":1,"c":2},"a":[{"f":3,"e":4}]}'))).toBe(
      '{"a":[{"e":4,"f":3}],"b":{"c":2,"d":1}}',
    );
  });

  it('renders null and empty containers without losing them', () => {
    expect(canonicalJson(JSON.parse('{"a":null,"b":[],"c":{}}'))).toBe('{"a":null,"b":[],"c":{}}');
  });
});

describe('doctor (pointed at a repo it does not manage)', () => {
  it('reports the missing config and checks nothing else', () => {
    // What doctor prints for any repo that was never adopted. Nothing else can be checked
    // without a config, so one clear line beats a page of failures about absent files.
    const projectDir = mkdtempSync(join(tmpdir(), 'athena-doctor-'));
    try {
      expect(run(projectDir)).toEqual([
        { name: 'config', ok: false, detail: '.athena/config.json missing' },
      ]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('does not check AGENTS.md freshness when the layers failed to build', () => {
    // Mirror of the claude-side case: with no hash there is nothing to compare against, so
    // the check is omitted rather than reported as drift against a hash that never existed.
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

      const names = run(projectDir).map((check) => check.name);

      expect(names).toContain('layers');
      expect(names).toContain('.codex/config.toml');
      expect(names).not.toContain('AGENTS.md');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe('doctor (reformatting a settings file is not tampering)', () => {
  it('passes a reindented settings.json and says why', () => {
    // The point of comparing meaning rather than bytes: an editor that reindents the file,
    // or a Windows tool that rewrites its line endings, changes every byte and no rule.
    // Reporting that as drift is how a check trains people to ignore it.
    withProject(bothTools, (projectDir) => {
      const path = join(projectDir, '.claude', 'settings.json');
      writeFileSync(path, JSON.stringify(JSON.parse(readFileSync(path, 'utf8')), null, 4));

      const check = run(projectDir).find((candidate) => candidate.name === '.claude/settings.json');

      expect(check?.ok).toBe(true);
      expect(check?.detail).toBe('matches the t1 profile (formatting differs, rules identical)');
    });
  });
});

/** Run doctor's CLI in-process, capturing what it printed and the exit code it set. */
const runCli = (projectDir: string): { lines: string[]; exitCode: number | string | undefined } => {
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  process.argv = ['node', 'doctor.ts', projectDir];
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

describe('doctor CLI (the exit code is the enforcement, not the printout)', () => {
  it('exits non-zero when any check fails', () => {
    // This is the line that makes drift stop a workflow. Were it to regress, athena-sync
    // would keep reporting success over a repo whose permission profile had been deleted.
    withProject(bothTools, (projectDir) => {
      rmSync(join(projectDir, '.claude', 'settings.json'));

      expect(runCli(projectDir).exitCode).toBe(1);
    });
  });

  it('leaves the exit code alone when every check passes', () => {
    withProject(bothTools, (projectDir) => {
      expect(runCli(projectDir).exitCode).toBeUndefined();
    });
  });

  it('prints one PASS or FAIL line per check', () => {
    withProject(bothTools, (projectDir) => {
      rmSync(join(projectDir, 'CLAUDE.md'));

      const { lines } = runCli(projectDir);

      expect(lines).toHaveLength(8);
      expect(lines[0]).toBe('PASS  config — stack=ts tier=1 tools=claude,codex');
      expect(lines[1]).toBe('FAIL  CLAUDE.md — missing — run `athena compile`');
    });
  });
});

describe('doctor (a half-adopted repo still gets the friendly message)', () => {
  it('names the missing config even when .athena exists but is empty', () => {
    // The guard has to test the file, not the directory. Testing the directory would let a
    // deleted config.json fall through and surface as a raw ENOENT instead of the line that
    // says what to do about it, which is the whole value of the check.
    const projectDir = mkdtempSync(join(tmpdir(), 'athena-doctor-'));
    try {
      mkdirSync(join(projectDir, '.athena'), { recursive: true });

      expect(run(projectDir)).toEqual([
        { name: 'config', ok: false, detail: '.athena/config.json missing' },
      ]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('canonicalises undefined to null rather than to the empty string', () => {
    // JSON.parse never produces undefined, so this arm is defensive. Pinned anyway: an
    // empty string here would make two different documents canonicalise the same way.
    expect(canonicalJson(undefined)).toBe('null');
  });
});
