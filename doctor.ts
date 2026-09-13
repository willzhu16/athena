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
 * Canonical text for a parsed JSON value: object keys sorted, array order preserved, no
 * incidental whitespace. Two settings files with the same rules compare equal however they
 * are indented or ordered, while adding, removing or reordering a rule still differs —
 * arrays are compared positionally on purpose, since a permission list is not a set.
 */
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

/**
 * True when two JSON documents mean the same thing. Returns null when either side is not
 * valid JSON, so the caller can fall back to the byte comparison rather than treat an
 * unparseable file as equal.
 */
export const sameJson = (actual: string, expected: string): boolean | null => {
  try {
    return canonicalJson(JSON.parse(actual)) === canonicalJson(JSON.parse(expected));
  } catch {
    return null;
  }
};

/**
 * Check for a file athena installs verbatim — no header, no hash. Covers the permission
 * profile and the shipped slash commands.
 *
 * Bytes first, because that is the common case and the cheapest. For JSON the comparison
 * then falls back to meaning: an editor that reindents `.claude/settings.json`, or a
 * Windows tool that rewrites its line endings, changes every byte without changing a single
 * permission, and reporting that as tampering trains people to ignore the check. Anything
 * that alters the actual rules — added, removed or reordered — still fails. Non-JSON files
 * such as the slash commands stay byte-exact, since there is no meaning to compare.
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
  const actual = readFileSync(path, 'utf8');
  if (actual === expected) {
    return { name: relativePath, ok: true, detail: `matches ${label}` };
  }
  if (sameJson(actual, expected) === true) {
    return {
      name: relativePath,
      ok: true,
      detail: `matches ${label} (formatting differs, rules identical)`,
    };
  }
  return { name: relativePath, ok: false, detail: `content differs from ${label}` };
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
