import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AthenaConfig,
  buildBody,
  COMMANDS,
  computeHash,
  extractBody,
  SETTINGS_PROFILE,
  validateConfig,
} from './compile.ts';

/**
 * `athena doctor`: validates that a repo's harness state is consistent — config parses,
 * compiled files exist and are fresh against the current layers (drift detection), the
 * permission profile is installed, and the task-packet template is present. Run manually
 * and by the weekly athena-sync workflow (spec 04 §3).
 */

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const readConfig = (projectDir: string): AthenaConfig =>
  JSON.parse(readFileSync(join(projectDir, '.athena', 'config.json'), 'utf8')) as AthenaConfig;

const readProjectLayer = (projectDir: string): string => {
  const path = join(projectDir, '.athena', 'project.md');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
};

const presenceCheck = (projectDir: string, file: string): Check => {
  const ok = existsSync(join(projectDir, file));
  return { name: file, ok, detail: ok ? 'present' : 'missing' };
};

/**
 * Byte-exact check for a file athena installs verbatim — no header, no hash. Covers the
 * permission profile and the shipped slash commands. Byte-exact on purpose: a reformatted
 * settings file is still drift from the profile doctor is asserting.
 */
const verbatimCheck = (
  projectDir: string,
  relativePath: string,
  sourcePath: string,
  label: string,
): Check => {
  const path = join(projectDir, relativePath);
  if (!existsSync(path)) {
    return { name: relativePath, ok: false, detail: 'missing — run `athena compile`' };
  }

  let expected: string;
  try {
    expected = readFileSync(sourcePath, 'utf8');
  } catch (error) {
    // An unreadable source is an athena-side problem, but it still must surface as a FAIL
    // check — doctor reports, it never crashes.
    return {
      name: relativePath,
      ok: false,
      detail: `cannot read expected source ${label}: ${(error as Error).message}`,
    };
  }
  const ok = readFileSync(path, 'utf8') === expected;
  return {
    name: relativePath,
    ok,
    detail: ok ? `matches ${label}` : `content differs from ${label}`,
  };
};

/**
 * True iff a compiled file's ACTUAL body matches the expected content hash. Hashing the
 * real body — not the declared header hash — is what catches a hand-edit that leaves the
 * header intact, or stale content whose header still matches its own (outdated) body.
 */
export const isFresh = (compiledContent: string, expectedHash: string): boolean =>
  computeHash(extractBody(compiledContent)) === expectedHash;

const freshnessCheck = (projectDir: string, file: string, expectedHash: string): Check => {
  const path = join(projectDir, file);
  if (!existsSync(path)) {
    return { name: file, ok: false, detail: 'missing — run `athena compile`' };
  }
  const content = readFileSync(path, 'utf8');
  const actual = computeHash(extractBody(content));
  const ok = isFresh(content, expectedHash);
  return {
    name: file,
    ok,
    detail: ok
      ? `fresh (sha:${expectedHash})`
      : `drift: content sha:${actual} != expected sha:${expectedHash}`,
  };
};

/** Validate a repo's athena harness state. Returns one Check per invariant. */
export const doctor = (
  projectDir: string,
  instructionsDir: string,
  permissionsDir?: string,
  commandsDir?: string,
): Check[] => {
  if (!existsSync(join(projectDir, '.athena', 'config.json'))) {
    return [{ name: 'config', ok: false, detail: '.athena/config.json missing' }];
  }
  let config: AthenaConfig;
  try {
    config = readConfig(projectDir);
    validateConfig(config);
  } catch (error) {
    return [{ name: 'config', ok: false, detail: (error as Error).message }];
  }
  const checks: Check[] = [
    { name: 'config', ok: true, detail: `stack=${config.stack} tools=${config.tools.join(',')}` },
  ];
  let expectedHash: string | null = null;
  try {
    expectedHash = computeHash(buildBody(config, instructionsDir, readProjectLayer(projectDir)));
  } catch (error) {
    // A stack/target naming a nonexistent layer is a config problem to report, not a crash.
    // Only the freshness checks need the hash — the hash-independent checks still run below,
    // so one report shows everything wrong instead of revealing failures one fix at a time.
    checks.push({ name: 'layers', ok: false, detail: (error as Error).message });
  }
  const athenaRoot = dirname(fileURLToPath(import.meta.url));
  const resolvedPermissionsDir = permissionsDir ?? join(athenaRoot, 'permissions');
  const resolvedCommandsDir = commandsDir ?? join(athenaRoot, 'commands');
  if (config.tools.includes('claude')) {
    if (expectedHash !== null) {
      checks.push(freshnessCheck(projectDir, 'CLAUDE.md', expectedHash));
    }
    checks.push(
      verbatimCheck(
        projectDir,
        '.claude/settings.json',
        join(resolvedPermissionsDir, SETTINGS_PROFILE),
        't1 profile',
      ),
    );
    for (const command of COMMANDS) {
      checks.push(
        verbatimCheck(
          projectDir,
          `.claude/commands/${command}`,
          join(resolvedCommandsDir, command),
          `the ${command.replace(/\.md$/, '')} command`,
        ),
      );
    }
  }
  if (config.tools.includes('codex') && expectedHash !== null) {
    checks.push(freshnessCheck(projectDir, 'AGENTS.md', expectedHash));
  }
  checks.push(presenceCheck(projectDir, '.github/ISSUE_TEMPLATE/task.yml'));
  return checks;
};

const main = (): void => {
  const athenaDir = dirname(fileURLToPath(import.meta.url));
  const projectDir = process.argv[2] ?? process.cwd();
  const checks = doctor(projectDir, join(athenaDir, 'instructions'));
  for (const check of checks) {
    console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name} — ${check.detail}`);
  }
  if (checks.some((check) => !check.ok)) {
    process.exitCode = 1;
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
