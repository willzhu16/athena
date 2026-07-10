import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AthenaConfig, buildBody, computeHash, extractBody } from './compile.ts';

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

const settingsProfileCheck = (projectDir: string, permissionsDir: string): Check => {
  const path = join(projectDir, '.claude', 'settings.json');
  if (!existsSync(path)) {
    return { name: '.claude/settings.json', ok: false, detail: 'missing — run `athena compile`' };
  }

  const expected = readFileSync(join(permissionsDir, 't1.settings.json'), 'utf8');
  const actual = readFileSync(path, 'utf8');
  const ok = actual === expected;
  return {
    name: '.claude/settings.json',
    ok,
    detail: ok ? 'matches t1 profile' : 'content differs from t1 settings profile',
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
): Check[] => {
  if (!existsSync(join(projectDir, '.athena', 'config.json'))) {
    return [{ name: 'config', ok: false, detail: '.athena/config.json missing' }];
  }
  let config: AthenaConfig;
  try {
    config = readConfig(projectDir);
  } catch (error) {
    return [{ name: 'config', ok: false, detail: `unparseable: ${(error as Error).message}` }];
  }
  const checks: Check[] = [
    { name: 'config', ok: true, detail: `stack=${config.stack} tools=${config.tools.join(',')}` },
  ];
  const expectedHash = computeHash(
    buildBody(config, instructionsDir, readProjectLayer(projectDir)),
  );
  const resolvedPermissionsDir =
    permissionsDir ?? join(dirname(fileURLToPath(import.meta.url)), 'permissions');
  if (config.tools.includes('claude')) {
    checks.push(freshnessCheck(projectDir, 'CLAUDE.md', expectedHash));
    checks.push(settingsProfileCheck(projectDir, resolvedPermissionsDir));
  }
  if (config.tools.includes('codex')) {
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
