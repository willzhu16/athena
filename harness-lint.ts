import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AthenaConfig, buildBody, SETTINGS_PROFILE } from './compile.ts';

/**
 * `athena harness-lint`: measures and tests the harness itself, rather than a repo that
 * consumes it. compile answers "what do agents read" and doctor answers "is this repo
 * current"; neither answers "are the rules coherent, and what do they cost". Every check
 * here is deterministic and offline — no agent, no network, no API spend — so it can run
 * in the same gate as the unit tests.
 *
 * Three things it exists to catch: rules and permission profiles silently disagreeing, the
 * compiled bundle growing without anyone pricing it, and the same rule stated twice.
 */

export interface Finding {
  name: string;
  ok: boolean;
  detail: string;
}

export interface BundleCost {
  stack: string;
  targets: string[];
  chars: number;
  lines: number;
  estimatedTokens: number;
}

export interface Echo {
  line: string;
  layers: string[];
}

export interface CoherenceClaim {
  command: string;
  statedIn: string[];
  enforcement: 'denied' | 'advisory';
  deniedIn?: string[];
  reason?: string;
}

export interface AcknowledgedDeny {
  profile: string;
  rule: string;
  reason: string;
}

export interface CoherenceFile {
  note?: string;
  claims: CoherenceClaim[];
  acknowledgedUnsoundDenies: AcknowledgedDeny[];
}

export interface PermissionProfile {
  permissions: {
    allow: string[];
    deny: string[];
  };
}

export interface HarnessReport {
  findings: Finding[];
  costs: BundleCost[];
  echoes: Echo[];
  unclaimedDenies: string[];
}

/**
 * Estimated-token ceiling for the shared layer bundle. Run harness-lint for current
 * measurements; project instructions, skills and tool output are outside this budget.
 */
export const BUNDLE_TOKEN_BUDGET = 4000;

/** Cheap offline stand-in for a real tokenizer — no dependency, consistent across runs. */
const CHARS_PER_TOKEN = 4;

/** Below this, a repeated line is boilerplate ("## Testing") rather than a duplicated rule. */
const MIN_DUPLICATE_LENGTH = 40;

/** The coherence manifest, alongside the profiles it describes. */
export const COHERENCE_FILE = 'coherence.json';

const estimateTokens = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN);

/** Layer filenames sharing a prefix, reduced to the config value that selects them. */
const discover = (instructionsDir: string, prefix: string): string[] =>
  readdirSync(instructionsDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.md'))
    .map((name) => name.slice(prefix.length, -'.md'.length))
    .sort();

const subsetsOf = <T>(items: T[]): T[][] => {
  const result: T[][] = [[]];
  for (const item of items) {
    for (const subset of [...result]) {
      result.push([...subset, item]);
    }
  }
  return result;
};

interface Bundle {
  stack: string;
  targets: string[];
  body: string;
}

/** Every bundle a valid config can produce, so cost and duplication cover the real matrix. */
const bundles = (instructionsDir: string): Bundle[] => {
  const result: Bundle[] = [];
  for (const stack of discover(instructionsDir, '20-stack-')) {
    for (const targets of subsetsOf(discover(instructionsDir, '30-target-'))) {
      const config: AthenaConfig = { athenaVersion: 'v1', stack, targets, tools: ['claude'] };
      result.push({ stack, targets, body: buildBody(config, instructionsDir, '') });
    }
  }
  return result;
};

const label = (stack: string, targets: string[]): string =>
  `${stack}+${targets.length > 0 ? targets.join('+') : 'none'}`;

/** Price every shippable bundle. The project layer is excluded — each repo owns that. */
export const bundleCosts = (instructionsDir: string): BundleCost[] =>
  bundles(instructionsDir).map(({ stack, targets, body }) => ({
    stack,
    targets,
    chars: body.length,
    lines: body.split('\n').length,
    estimatedTokens: estimateTokens(body.length),
  }));

/** Hold the worst-case bundle to a budget, since that is what a two-target repo pays. */
export const budgetCheck = (costs: BundleCost[]): Finding => {
  if (costs.length === 0) {
    return { name: 'bundle budget', ok: false, detail: 'no bundles — instruction layers missing' };
  }
  const worst = costs.reduce((a, b) => (b.estimatedTokens > a.estimatedTokens ? b : a));
  const ok = worst.estimatedTokens <= BUNDLE_TOKEN_BUDGET;
  const summary = `worst case ${label(worst.stack, worst.targets)} ~${worst.estimatedTokens} tokens`;
  return {
    name: 'bundle budget',
    ok,
    detail: ok
      ? `${summary} (budget ${BUNDLE_TOKEN_BUDGET})`
      : `${summary} exceeds budget ${BUNDLE_TOKEN_BUDGET}`,
  };
};

/** Strip list markers and inline emphasis so two spellings of one rule compare equal. */
export const normalizeLine = (line: string): string =>
  line
    .replace(/^[\s>]*(?:[-*+]|\d+\.)\s+/, '')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const meaningfulLines = (text: string): string[] =>
  text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .map(normalizeLine)
    .filter((line) => line.length >= MIN_DUPLICATE_LENGTH);

/** Normalized lines appearing more than once in the same text. */
export const duplicateLines = (text: string): string[] => {
  const counts = new Map<string, number>();
  for (const line of meaningfulLines(text)) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([line]) => line);
};

/**
 * A rule repeated inside one bundle is paid for twice on every single request, so this is
 * a failure rather than a note.
 */
export const duplicateCheck = (instructionsDir: string): Finding => {
  const offenders = bundles(instructionsDir)
    .map(({ stack, targets, body }) => ({
      name: label(stack, targets),
      dupes: duplicateLines(body),
    }))
    .filter((bundle) => bundle.dupes.length > 0)
    .map((bundle) => `${bundle.name} (${bundle.dupes.length})`);
  return {
    name: 'bundle duplicates',
    ok: offenders.length === 0,
    detail:
      offenders.length === 0
        ? 'no rule line repeats inside any bundle'
        : `repeated rule lines in ${offenders.join(', ')}`,
  };
};

/**
 * The same rule in two layers. Usually deliberate (the ts and python layers mirror each
 * other) and harmless in the bundle, since only one loads — but it is the thing that goes
 * stale when one copy is edited, so it is reported rather than hidden.
 */
export const crossLayerEchoes = (instructionsDir: string): Echo[] => {
  const byLine = new Map<string, string[]>();
  const layers = readdirSync(instructionsDir)
    .filter((name) => name.endsWith('.md'))
    .sort();
  for (const name of layers) {
    for (const line of new Set(
      meaningfulLines(readFileSync(join(instructionsDir, name), 'utf8')),
    )) {
      byLine.set(line, [...(byLine.get(line) ?? []), name]);
    }
  }
  return [...byLine.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([line, names]) => ({ line, layers: names }));
};

export const readProfile = (permissionsDir: string, tier: string): PermissionProfile =>
  JSON.parse(
    readFileSync(join(permissionsDir, `${tier}.settings.json`), 'utf8'),
  ) as PermissionProfile;

const BASH_RULE = /^Bash\((.+?)(?::\*)?\)$/;

/** The command inside a `Bash(...)` permission rule; null for Read/Write/Edit rules. */
export const bashCommand = (rule: string): string | null => {
  const match = rule.match(BASH_RULE);
  return match ? match[1] : null;
};

/**
 * True when a deny pattern names a flag. Permission rules match on the leading text of a
 * command, so a flag written into the pattern is only caught in that exact position —
 * moving it after positional arguments walks around the rule (REVIEW-2026-07-15 #7).
 */
export const isOrderSensitive = (command: string): boolean =>
  command.split(/\s+/).some((token) => token.startsWith('-'));

/** Deny rules in a profile that a reordered command can evade. */
export const unsoundDenies = (profile: PermissionProfile): string[] =>
  profile.permissions.deny.filter((rule) => {
    const command = bashCommand(rule);
    return command !== null && isOrderSensitive(command);
  });

const soundnessFinding = (
  tier: string,
  unsound: string[],
  acknowledged: AcknowledgedDeny[],
): Finding => {
  const known = acknowledged.filter((entry) => entry.profile === tier);
  const unlisted = unsound.filter((rule) => !known.some((entry) => entry.rule === rule));
  const stale = known.filter((entry) => !unsound.includes(entry.rule));
  const problems = [
    ...unlisted.map((rule) => `unacknowledged ${rule}`),
    ...stale.map((entry) => `stale acknowledgement ${entry.rule}`),
  ];
  return {
    name: `deny soundness (${tier})`,
    ok: problems.length === 0,
    detail:
      problems.length === 0
        ? `${unsound.length} order-sensitive deny rule(s), all acknowledged`
        : problems.join('; '),
  };
};

/** One finding per profile: every evadable deny must carry a written acknowledgement. */
export const denySoundnessChecks = (
  permissionsDir: string,
  acknowledged: AcknowledgedDeny[],
): Finding[] =>
  readdirSync(permissionsDir)
    .filter((name) => name.endsWith('.settings.json'))
    .map((name) => name.replace('.settings.json', ''))
    .sort()
    .map((tier) =>
      soundnessFinding(tier, unsoundDenies(readProfile(permissionsDir, tier)), acknowledged),
    );

const statesCommand = (instructionsDir: string, layer: string, command: string): boolean => {
  const path = join(instructionsDir, layer);
  return existsSync(path) && readFileSync(path, 'utf8').includes(command);
};

/**
 * Whether a tier blocks a command. A claim naming a tier with no profile on disk reports
 * as `missing` rather than throwing — like doctor, this tool reports and never crashes.
 */
const denyState = (
  permissionsDir: string,
  tier: string,
  command: string,
): 'denied' | 'open' | 'missing' => {
  let profile: PermissionProfile;
  try {
    profile = readProfile(permissionsDir, tier);
  } catch {
    return 'missing';
  }
  // Claims describe command families, not one exact invocation. A narrower subcommand
  // or an exact-only deny cannot cover that family. Deliberately do not guess at complex
  // globs: this proves direct prefix coverage, not runtime isolation or all spellings.
  const denied = profile.permissions.deny.some((rule) => {
    if (rule === 'Bash' || rule === 'Bash(*)') return true;
    const prefix = rule.match(/^Bash\(([^*]+?)(?::\*| \*)\)$/)?.[1];
    return prefix !== undefined && (command === prefix || command.startsWith(`${prefix} `));
  });
  return denied ? 'denied' : 'open';
};

const claimFinding = (
  claim: CoherenceClaim,
  instructionsDir: string,
  permissionsDir: string,
): Finding => {
  const name = `claim ${claim.command}`;
  if (!claim.command?.trim() || !Array.isArray(claim.statedIn) || claim.statedIn.length === 0) {
    return { name, ok: false, detail: 'claim needs a command and at least one source layer' };
  }
  const unstated = claim.statedIn.filter(
    (layer) => !statesCommand(instructionsDir, layer, claim.command),
  );
  if (unstated.length > 0) {
    return { name, ok: false, detail: `no longer stated in ${unstated.join(', ')}` };
  }
  if (claim.enforcement === 'advisory') {
    const ok = (claim.reason ?? '').trim().length > 0;
    return {
      name,
      ok,
      detail: ok
        ? 'advisory by design — stated, deliberately not walled'
        : 'advisory with no reason',
    };
  }
  const tiers = claim.deniedIn ?? [];
  if (claim.enforcement !== 'denied' || !Array.isArray(tiers) || tiers.length === 0) {
    return { name, ok: false, detail: 'denied claim needs at least one permission profile' };
  }
  const states = tiers.map((tier) => ({
    tier,
    state: denyState(permissionsDir, tier, claim.command),
  }));
  const tiersIn = (state: string): string[] =>
    states.filter((entry) => entry.state === state).map((entry) => entry.tier);
  const open = tiersIn('open');
  const missing = tiersIn('missing');
  const problems = [
    ...(open.length > 0 ? [`not denied in ${open.join(', ')}`] : []),
    ...(missing.length > 0 ? [`no profile on disk for ${missing.join(', ')}`] : []),
  ];
  return {
    name,
    ok: problems.length === 0,
    detail:
      problems.length === 0
        ? `stated; direct prefix denied in ${tiers.join(', ')}`
        : problems.join('; '),
  };
};

/** Assert both halves of every claim: the layer still says it, the profile still blocks it. */
export const claimChecks = (
  claims: CoherenceClaim[],
  instructionsDir: string,
  permissionsDir: string,
): Finding[] => claims.map((claim) => claimFinding(claim, instructionsDir, permissionsDir));

/**
 * Deny rules in the shipped profile that no claim explains. Not a failure — an agent
 * hitting an unexplained wall is a documentation gap, and this is the list of them.
 */
export const unclaimedDenies = (permissionsDir: string, claims: CoherenceClaim[]): string[] => {
  const tier = SETTINGS_PROFILE.replace('.settings.json', '');
  let profile: PermissionProfile;
  try {
    profile = readProfile(permissionsDir, tier);
  } catch {
    // Informational output only — a missing profile is already a failed claim check.
    return [];
  }
  return profile.permissions.deny.filter((rule) => {
    const command = bashCommand(rule);
    return command !== null && !claims.some((claim) => command.startsWith(claim.command));
  });
};

export const readCoherence = (permissionsDir: string): CoherenceFile => {
  const value = JSON.parse(readFileSync(join(permissionsDir, COHERENCE_FILE), 'utf8'));
  if (
    !value ||
    !Array.isArray(value.claims) ||
    value.claims.length === 0 ||
    !Array.isArray(value.acknowledgedUnsoundDenies)
  ) {
    throw new Error('manifest needs non-empty claims and an acknowledgedUnsoundDenies array');
  }
  const nonemptyStrings = (items: unknown): items is string[] =>
    Array.isArray(items) &&
    items.length > 0 &&
    items.every((item) => typeof item === 'string' && item.trim().length > 0);
  for (const claim of value.claims) {
    if (
      !claim ||
      typeof claim.command !== 'string' ||
      !claim.command.trim() ||
      !nonemptyStrings(claim.statedIn) ||
      (claim.enforcement !== 'denied' && claim.enforcement !== 'advisory') ||
      (claim.enforcement === 'denied' && !nonemptyStrings(claim.deniedIn)) ||
      (claim.enforcement === 'advisory' &&
        (typeof claim.reason !== 'string' || !claim.reason.trim()))
    ) {
      throw new Error(
        'invalid coherence claim: command, source layers and enforcement are required',
      );
    }
  }
  for (const entry of value.acknowledgedUnsoundDenies) {
    if (!entry || !nonemptyStrings([entry.profile, entry.rule, entry.reason])) {
      throw new Error('invalid deny acknowledgement: profile, rule and reason are required');
    }
  }
  return value as CoherenceFile;
};

/** Run every harness check. Pure reporting: a broken manifest fails a check, never throws. */
export const harnessLint = (instructionsDir: string, permissionsDir: string): HarnessReport => {
  let coherence: CoherenceFile;
  try {
    coherence = readCoherence(permissionsDir);
  } catch (error) {
    const detail = `unreadable ${COHERENCE_FILE}: ${(error as Error).message}`;
    return {
      findings: [{ name: 'coherence', ok: false, detail }],
      costs: [],
      echoes: [],
      unclaimedDenies: [],
    };
  }
  const costs = bundleCosts(instructionsDir);
  return {
    findings: [
      ...claimChecks(coherence.claims, instructionsDir, permissionsDir),
      ...denySoundnessChecks(permissionsDir, coherence.acknowledgedUnsoundDenies),
      budgetCheck(costs),
      duplicateCheck(instructionsDir),
    ],
    costs,
    echoes: crossLayerEchoes(instructionsDir),
    unclaimedDenies: unclaimedDenies(permissionsDir, coherence.claims),
  };
};

const printReport = (report: HarnessReport): void => {
  for (const finding of report.findings) {
    console.log(`${finding.ok ? 'PASS' : 'FAIL'}  ${finding.name} — ${finding.detail}`);
  }
  console.log('\nBundle cost (layers only, project layer excluded):');
  for (const cost of report.costs) {
    const name = label(cost.stack, cost.targets).padEnd(24);
    console.log(
      `  ${name} ${String(cost.estimatedTokens).padStart(5)} tokens  ${cost.lines} lines`,
    );
  }
  if (report.echoes.length > 0) {
    console.log(`\nRules stated in more than one layer (${report.echoes.length}):`);
    for (const echo of report.echoes) {
      console.log(`  ${echo.layers.join(' + ')}\n    ${echo.line}`);
    }
  }
  if (report.unclaimedDenies.length > 0) {
    console.log(`\nDeny rules no instruction layer explains (${report.unclaimedDenies.length}):`);
    for (const rule of report.unclaimedDenies) {
      console.log(`  ${rule}`);
    }
  }
};

const main = (): void => {
  const athenaDir = dirname(fileURLToPath(import.meta.url));
  const report = harnessLint(join(athenaDir, 'instructions'), join(athenaDir, 'permissions'));
  printReport(report);
  if (report.findings.some((finding) => !finding.ok)) {
    process.exitCode = 1;
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
