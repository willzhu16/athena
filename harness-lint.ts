import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AthenaConfig,
  buildBody,
  COMMANDS,
  codexProfileFor,
  codexRulesFor,
  HOOKS,
  KNOWN_TIERS,
  SETTINGS_PROFILE,
  SKILLS,
  settingsProfileFor,
} from './compile.ts';

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

export interface HookHandler {
  type: string;
  command: string;
  timeout?: number;
}

/** One hook event's entries. Stop takes no matcher, so the handlers hang off the entry. */
export interface HookEntry {
  matcher?: string;
  hooks: HookHandler[];
}

export interface PermissionProfile {
  permissions: {
    allow: string[];
    deny: string[];
  };
  /** Optional so a profile predating hooks still parses as a valid profile. */
  hooks?: Record<string, HookEntry[]>;
}

export interface HarnessReport {
  findings: Finding[];
  costs: BundleCost[];
  commandCosts: CommandCost[];
  echoes: Echo[];
  commandEchoes: Echo[];
  unclaimedDenies: string[];
  scorecard: Scorecard | null;
}

/**
 * Estimated-token ceiling for the shared layer bundle, ratcheted to the measured worst case
 * rather than invented — the same move platform made with its coverage floor. 4000 was a
 * guess with 16% slack, guarding a two-target configuration no repo in the fleet actually
 * loads; the real shipping bundles are smaller (cf-worker-app ~3006, py-tool ~2451).
 *
 * Raising this is meant to be a deliberate one-line act that shows up in a diff alongside
 * the regenerated scorecard. Project instructions, skills and tool output sit outside it.
 *
 * Raised 3600 -> 3800 on 2026-09-17 by owner decision, to pay for the hooks section in
 * 00-universal. Worth naming the tension: the research behind that section says instruction
 * text is the least effective harness edit there is, so a rising number here is a cost to
 * justify, not headroom to spend. The section earns it by pointing at a gate that runs on
 * its own; prose that only asks an agent to remember something does not.
 *
 * Raised 3800 -> 3900 on 2026-09-19, and this one was not free. It pays for three
 * corrections: 20-stack-python listed under "what the linter can't check" three rules ruff
 * now checks, 30-target-workers said `nodejs_compat` was opt-in when the template ships it
 * on, and the session-log format had drifted from platform's template. Absorbing it was
 * tried first and mostly failed — deduplicating the Honesty section against the hooks
 * section and cutting the python layer's stale bullets clawed back most of +141, not all of
 * it. Two link-consolidation attempts made it worse and were reverted.
 *
 * The number to question next is what this budget measures, not how big it is. The worst
 * case is ts+vscode-ext+workers, a two-target configuration no repo in the fleet loads. The
 * bundles that actually ship are far smaller (ts+workers ~3419, python+none ~2841), so this
 * ceiling is pricing a hypothetical while the real ones have hundreds of tokens spare.
 * Budgeting the shipping configurations instead would be a truer gate — a design change,
 * logged in TODO.md rather than smuggled in here.
 */
export const BUNDLE_TOKEN_BUDGET = 3900;

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

const normalizeOnce = (line: string): string =>
  line
    .replace(/^[\s>]*(?:[-*+]|\d+\.)\s+/, '')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/**
 * Strip list markers and inline emphasis so two spellings of one rule compare equal.
 *
 * Applied to a fixed point rather than once, because removing emphasis can expose a list
 * marker that was hidden underneath it: `_1. never force-push_` came out as
 * `1. never force-push` while its plain twin came out as `never force-push`, so the two
 * spellings of one rule did not compare equal and the duplicate went unreported. Found by
 * the idempotence property in properties.test.ts.
 *
 * Terminates: after the first pass no emphasis characters remain, so every later pass can
 * only shorten the line.
 */
export const normalizeLine = (line: string): string => {
  let current = normalizeOnce(line);
  let next = normalizeOnce(current);
  while (next !== current) {
    current = next;
    next = normalizeOnce(current);
  }
  return current;
};

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

/** A slash command copied verbatim into every claude repo, priced like a layer. */
export interface CommandCost {
  name: string;
  chars: number;
  lines: number;
  estimatedTokens: number;
}

/**
 * The committed scorecard. Cost and coverage were only ever visible to whoever ran the CLI,
 * so the bundle grew ~20% across three sessions unnoticed. Committing the numbers puts the
 * delta in the diff of every PR that moves them — the same trick compile uses with its
 * content hash, applied to the harness itself.
 */
export interface Scorecard {
  note: string;
  budget: { bundleTokens: number };
  bundles: {
    worstCase: { config: string; estimatedTokens: number };
    perConfig: Record<string, number>;
  };
  commands: Record<string, number>;
  /**
   * Priced in two halves on purpose. `alwaysOn` is what every request pays for the whole
   * skill surface — the descriptions — and is the number to watch. `onDemand` is what a
   * body costs only when something routes to it, which is the saving the mechanism exists
   * for. A single total would hide exactly the ratio worth knowing.
   */
  skills: {
    budgetTokens: number;
    alwaysOnTokens: number;
    onDemandTokens: Record<string, number>;
  };
  coverage: {
    claims: number;
    advisoryClaims: number;
    acknowledgedUnsoundDenies: number;
    unclaimedDenies: number;
    crossLayerEchoes: number;
    commandEchoes: number;
  };
}

export const SCORECARD_FILE = 'harness-scorecard.json';

const SCORECARD_NOTE =
  'Generated by `pnpm harness-lint --write`. Committed so cost and coverage changes ' +
  'appear in the PR diff; harness-lint fails when it is stale.';

const commandFiles = (commandsDir: string): string[] =>
  existsSync(commandsDir)
    ? readdirSync(commandsDir)
        .filter((name) => name.endsWith('.md'))
        .sort()
    : [];

const readCommand = (commandsDir: string, name: string): string =>
  readFileSync(join(commandsDir, name), 'utf8');

/** Commands load on demand, not on every request, so they are reported and not budgeted. */
export const commandCosts = (commandsDir: string): CommandCost[] =>
  commandFiles(commandsDir).map((name) => {
    const body = readCommand(commandsDir, name);
    return {
      name,
      chars: body.length,
      lines: body.split('\n').length,
      estimatedTokens: estimateTokens(body.length),
    };
  });

/**
 * A command file COMMANDS does not list never ships; a listed file that does not exist
 * makes compile throw. Both stay silent until someone reaches for the command.
 */
export const commandsManifestCheck = (commandsDir: string): Finding => {
  const onDisk = commandFiles(commandsDir);
  const listed: string[] = [...COMMANDS];
  const orphans = onDisk.filter((name) => !listed.includes(name));
  const absent = listed.filter((name) => !onDisk.includes(name));
  const problems = [
    ...(orphans.length > 0 ? [`on disk but not in COMMANDS: ${orphans.join(', ')}`] : []),
    ...(absent.length > 0 ? [`in COMMANDS but not on disk: ${absent.join(', ')}`] : []),
  ];
  return {
    name: 'commands manifest',
    ok: problems.length === 0,
    detail:
      problems.length === 0 ? `${listed.length} command(s), all present` : problems.join('; '),
  };
};

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;

/**
 * Claude Code takes a command's description from its frontmatter. A malformed block still
 * installs, so the command shows up unlabelled instead of failing.
 */
export const commandFrontmatterChecks = (commandsDir: string): Finding[] =>
  commandFiles(commandsDir).map((name) => {
    const match = readCommand(commandsDir, name).match(FRONTMATTER);
    if (!match) {
      return { name: `command ${name}`, ok: false, detail: 'no --- frontmatter block' };
    }
    const description = match[1].match(/^description:\s*(\S.*)$/m);
    if (!description) {
      return { name: `command ${name}`, ok: false, detail: 'frontmatter has no description' };
    }
    return { name: `command ${name}`, ok: true, detail: `described in ${match[1].length} chars` };
  });

/** A line repeated inside one command is waste with no upside, unlike a cross-file echo. */
export const commandDuplicateCheck = (commandsDir: string): Finding => {
  const offenders = commandFiles(commandsDir)
    .map((name) => ({ name, dupes: duplicateLines(readCommand(commandsDir, name)) }))
    .filter((entry) => entry.dupes.length > 0)
    .map((entry) => `${entry.name} (${entry.dupes.length})`);
  return {
    name: 'command duplicates',
    ok: offenders.length === 0,
    detail:
      offenders.length === 0
        ? 'no line repeats inside a command'
        : `repeated lines in ${offenders.join(', ')}`,
  };
};

/**
 * A command usually has a same-named process doc at the athena root. That doc must point at
 * the command, or the pair drifts — which is exactly what `conductor.md` currently asks a
 * human to prevent by hand ("Keep the two in step").
 */
export const commandCrossLinkCheck = (commandsDir: string): Finding => {
  const root = dirname(commandsDir);
  const dangling = commandFiles(commandsDir).filter((name) => {
    const doc = join(root, name);
    return existsSync(doc) && !readFileSync(doc, 'utf8').includes(`commands/${name}`);
  });
  return {
    name: 'command cross-links',
    ok: dangling.length === 0,
    detail:
      dangling.length === 0
        ? 'every process doc points at its shipped command'
        : `process doc never references its command: ${dangling.join(', ')}`,
  };
};

/** Hook scripts on disk, so the manifest is checked against reality rather than itself. */
const hookFiles = (hooksDir: string): string[] =>
  existsSync(hooksDir)
    ? readdirSync(hooksDir)
        .filter((name) => name.endsWith('.mjs'))
        .sort()
    : [];

/**
 * A hook file HOOKS does not list never ships; a listed file that does not exist makes
 * compile throw. Same silent pair as the commands manifest, same check.
 */
export const hooksManifestCheck = (hooksDir: string): Finding => {
  const onDisk = hookFiles(hooksDir);
  const listed: string[] = [...HOOKS];
  const orphans = onDisk.filter((name) => !listed.includes(name));
  const absent = listed.filter((name) => !onDisk.includes(name));
  const problems = [
    ...(orphans.length > 0 ? [`on disk but not in HOOKS: ${orphans.join(', ')}`] : []),
    ...(absent.length > 0 ? [`in HOOKS but not on disk: ${absent.join(', ')}`] : []),
  ];
  return {
    name: 'hooks manifest',
    ok: problems.length === 0,
    detail: problems.length === 0 ? `${listed.length} hook(s), all present` : problems.join('; '),
  };
};

/** Every command string configured across a profile's hook events, flattened. */
const configuredHookCommands = (profile: PermissionProfile): string[] =>
  Object.values(profile.hooks ?? {}).flatMap((entries) =>
    entries.flatMap((entry) => entry.hooks.map((handler) => handler.command)),
  );

/**
 * A shipped hook that no profile references is a dead script that reads like a gate — the
 * worst failure this repo has, because it looks exactly like enforcement while enforcing
 * nothing. Checked per tier, since a profile is the only thing that makes a hook run.
 */
export const hooksWiredCheck = (permissionsDir: string): Finding[] =>
  (KNOWN_TIERS as readonly number[]).map((tier) => {
    const commands = configuredHookCommands(readProfile(permissionsDir, `t${tier}`));
    const unreferenced = [...HOOKS].filter(
      (hook) => !commands.some((command) => command.includes(`.claude/hooks/${hook}`)),
    );
    return {
      name: `hooks wired t${tier}`,
      ok: unreferenced.length === 0,
      detail:
        unreferenced.length === 0
          ? `every hook is referenced by the t${tier} profile`
          : `shipped but never run under t${tier}: ${unreferenced.join(', ')}`,
    };
  });

/** Skill directories on disk, so the manifest is checked against reality rather than itself. */
const skillDirs = (skillsDir: string): string[] =>
  existsSync(skillsDir)
    ? readdirSync(skillsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    : [];

const readSkill = (skillsDir: string, name: string): string =>
  readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8');

/**
 * Ceiling on the combined skill descriptions. This is the number that matters: descriptions
 * are preloaded on every request, bodies are not, so the whole point of moving procedure into
 * a skill is defeated if the descriptions grow like a layer. Deliberately far tighter than
 * the bundle budget, because this is the always-on cost of the on-demand mechanism.
 */
export const SKILL_DESCRIPTION_BUDGET = 400;

/** The `description:` line of a skill, or null when the frontmatter is missing or unlabelled. */
export const skillDescription = (source: string): string | null => {
  const match = source.match(FRONTMATTER);
  if (!match) {
    return null;
  }
  const described = match[1].match(/^description:\s*(\S.*)$/m);
  return described ? described[1].trim() : null;
};

/**
 * A skill with no description never loads. Claude Code routes on the description alone, so an
 * absent one is not a cosmetic gap: the body ships and is unreachable, which reads in a diff
 * exactly like a skill that works.
 */
export const skillFrontmatterChecks = (skillsDir: string): Finding[] =>
  skillDirs(skillsDir).map((name) => {
    const description = skillDescription(readSkill(skillsDir, name));
    if (description === null) {
      return { name: `skill ${name}`, ok: false, detail: 'no description in frontmatter' };
    }
    return { name: `skill ${name}`, ok: true, detail: `routes on ${description.length} chars` };
  });

/** A skill directory SKILLS does not list never ships; a listed one absent makes compile throw. */
export const skillsManifestCheck = (skillsDir: string): Finding => {
  const onDisk = skillDirs(skillsDir);
  const listed: string[] = [...SKILLS];
  const orphans = onDisk.filter((name) => !listed.includes(name));
  const absent = listed.filter((name) => !onDisk.includes(name));
  const problems = [
    ...(orphans.length > 0 ? [`on disk but not in SKILLS: ${orphans.join(', ')}`] : []),
    ...(absent.length > 0 ? [`in SKILLS but not on disk: ${absent.join(', ')}`] : []),
  ];
  return {
    name: 'skills manifest',
    ok: problems.length === 0,
    detail: problems.length === 0 ? `${listed.length} skill(s), all present` : problems.join('; '),
  };
};

/** Always-on cost of the skill surface: the descriptions, never the bodies. */
export const skillDescriptionCost = (skillsDir: string): number =>
  skillDirs(skillsDir).reduce(
    (total, name) =>
      total + estimateTokens((skillDescription(readSkill(skillsDir, name)) ?? '').length),
    0,
  );

export const skillBudgetCheck = (skillsDir: string): Finding => {
  const cost = skillDescriptionCost(skillsDir);
  const ok = cost <= SKILL_DESCRIPTION_BUDGET;
  return {
    name: 'skill descriptions',
    ok,
    detail: ok
      ? `~${cost} always-on tokens (budget ${SKILL_DESCRIPTION_BUDGET})`
      : `~${cost} always-on tokens exceeds budget ${SKILL_DESCRIPTION_BUDGET}`,
  };
};

/** Content words of a description, for comparing what two skills claim to cover. */
const claimWords = (description: string): Set<string> =>
  new Set(
    normalizeLine(description)
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 3),
  );

/**
 * Above this share of shared content words, two descriptions are describing the same
 * capability and routing between them is a coin flip.
 */
const AMBIGUITY_THRESHOLD = 0.6;

/**
 * Two skills whose descriptions overlap heavily are a measured failure class, not a style
 * nit: the router picks between them on wording alone, so whichever it picks is arbitrary
 * and the other may as well not exist. Reported per pair, because the fix is to sharpen one
 * description against the other rather than to shorten either.
 */
export const skillAmbiguityCheck = (skillsDir: string): Finding => {
  const described = skillDirs(skillsDir)
    .map((name) => ({
      name,
      words: claimWords(skillDescription(readSkill(skillsDir, name)) ?? ''),
    }))
    .filter((entry) => entry.words.size > 0);
  const collisions: string[] = [];
  for (let first = 0; first < described.length; first++) {
    for (let second = first + 1; second < described.length; second++) {
      const a = described[first];
      const b = described[second];
      const shared = [...a.words].filter((word) => b.words.has(word)).length;
      const overlap = shared / Math.min(a.words.size, b.words.size);
      if (overlap > AMBIGUITY_THRESHOLD) {
        collisions.push(`${a.name} vs ${b.name} (${Math.round(overlap * 100)}% shared)`);
      }
    }
  }
  return {
    name: 'skill ambiguity',
    ok: collisions.length === 0,
    detail:
      collisions.length === 0
        ? `${described.length} skill(s), each claiming distinct ground`
        : `descriptions overlap, so routing is arbitrary: ${collisions.join('; ')}`,
  };
};

/** Lines a command shares with an instruction layer: not waste, but they drift in pairs. */
export const commandEchoes = (instructionsDir: string, commandsDir: string): Echo[] => {
  const byLine = new Map<string, string[]>();
  for (const layer of readdirSync(instructionsDir)
    .filter((name) => name.endsWith('.md'))
    .sort()) {
    for (const line of new Set(
      meaningfulLines(readFileSync(join(instructionsDir, layer), 'utf8')),
    )) {
      byLine.set(line, [...(byLine.get(line) ?? []), layer]);
    }
  }
  const echoes: Echo[] = [];
  for (const name of commandFiles(commandsDir)) {
    for (const line of new Set(meaningfulLines(readCommand(commandsDir, name)))) {
      const layers = byLine.get(line);
      if (layers !== undefined) {
        echoes.push({ line, layers: [`commands/${name}`, ...layers] });
      }
    }
  }
  return echoes;
};

/**
 * t1 denies reading secret files; the Codex profile must deny the same ones. The two
 * formats cannot be compared field by field — Codex has no per-command deny list at all —
 * so this asserts the one thing both schemas can express, rather than pretending the
 * command half maps across. See permissions/README.md.
 */
export const codexSecretsCheck = (permissionsDir: string): Finding[] =>
  (KNOWN_TIERS as readonly number[]).map((tier) => {
    const name = `codex t${tier} secret denials`;
    const claudeProfile = settingsProfileFor(tier);
    const codexProfile = codexProfileFor(tier);
    if (!existsSync(join(permissionsDir, claudeProfile))) {
      // No claude profile for this tier means the tier does not ship; nothing to pair.
      return { name, ok: true, detail: `tier ${tier} ships no profile` };
    }
    const codexRules = codexRulesFor(tier);
    const missing = [codexProfile, codexRules].filter(
      (file) => !existsSync(join(permissionsDir, file)),
    );
    if (missing.length > 0) {
      // Both halves or neither: Codex splits file access and command policy across two
      // files, so a tier shipping only one of them enforces half of what it promises.
      return {
        name,
        ok: false,
        detail: `${claudeProfile} exists but ${missing.join(' and ')} does not`,
      };
    }
    const codexLines = readFileSync(join(permissionsDir, codexProfile), 'utf8').split('\n');
    let claude: PermissionProfile;
    try {
      claude = readProfile(permissionsDir, `t${tier}`);
    } catch (error) {
      return {
        name,
        ok: false,
        detail: `cannot read ${claudeProfile}: ${(error as Error).message}`,
      };
    }
    // Plain string matching on purpose. Turning a TOML glob into a regex means escaping `**`
    // into a pattern language it does not belong to, which is how this check got its first
    // bug; the profiles are a few lines long and a literal comparison cannot misfire.
    const claudeDenies = (needle: string): boolean =>
      claude.permissions.deny.some((rule) => rule.includes(needle));
    const codexDenies = (needle: string): boolean =>
      codexLines.some((line) => line.includes(needle) && line.includes('"deny"'));
    // t0 denies the edit tools wholesale rather than naming secret paths, so its secret
    // denials are asserted directly instead of against the claude list.
    const wanted =
      tier === 0 ? ['secrets/**', '.env'] : ['secrets/**', '.env'].filter(claudeDenies);
    const gaps = wanted.filter((needle) => !codexDenies(needle));
    return {
      name,
      ok: gaps.length === 0,
      detail:
        gaps.length === 0
          ? `${codexProfile} denies ${wanted.join(', ') || 'nothing required'}`
          : `${codexProfile} does not deny: ${gaps.join(', ')}`,
    };
  });

/** Assemble the committed numbers. Ordering is fixed so the serialization is stable. */
export const buildScorecard = (
  costs: BundleCost[],
  commands: CommandCost[],
  coherence: CoherenceFile,
  unclaimed: string[],
  layerEchoes: Echo[],
  cmdEchoes: Echo[],
  skillsDir: string,
): Scorecard => {
  const worst = costs.reduce((a, b) => (b.estimatedTokens > a.estimatedTokens ? b : a));
  const perConfig: Record<string, number> = {};
  for (const cost of costs) {
    perConfig[label(cost.stack, cost.targets)] = cost.estimatedTokens;
  }
  const commandTokens: Record<string, number> = {};
  for (const command of commands) {
    commandTokens[command.name] = command.estimatedTokens;
  }
  const skillBodies: Record<string, number> = {};
  for (const name of skillDirs(skillsDir)) {
    skillBodies[name] = estimateTokens(readSkill(skillsDir, name).length);
  }
  return {
    note: SCORECARD_NOTE,
    budget: { bundleTokens: BUNDLE_TOKEN_BUDGET },
    bundles: {
      worstCase: {
        config: label(worst.stack, worst.targets),
        estimatedTokens: worst.estimatedTokens,
      },
      perConfig,
    },
    commands: commandTokens,
    skills: {
      budgetTokens: SKILL_DESCRIPTION_BUDGET,
      alwaysOnTokens: skillDescriptionCost(skillsDir),
      onDemandTokens: skillBodies,
    },
    coverage: {
      claims: coherence.claims.length,
      advisoryClaims: coherence.claims.filter((claim) => claim.enforcement === 'advisory').length,
      acknowledgedUnsoundDenies: coherence.acknowledgedUnsoundDenies.length,
      unclaimedDenies: unclaimed.length,
      crossLayerEchoes: layerEchoes.length,
      commandEchoes: cmdEchoes.length,
    },
  };
};

export const serializeScorecard = (scorecard: Scorecard): string =>
  `${JSON.stringify(scorecard, null, 2)}\n`;

/** Compare the committed scorecard to the freshly measured one, the way doctor compares files. */
export const scorecardCheck = (athenaRoot: string, scorecard: Scorecard): Finding => {
  const path = join(athenaRoot, SCORECARD_FILE);
  const expected = serializeScorecard(scorecard);
  if (!existsSync(path)) {
    return {
      name: SCORECARD_FILE,
      ok: false,
      detail: 'missing — run `pnpm harness-lint --write`',
    };
  }
  const actual = readFileSync(path, 'utf8');
  const ok = actual === expected;
  return {
    name: SCORECARD_FILE,
    ok,
    detail: ok
      ? `current (worst bundle ${scorecard.bundles.worstCase.estimatedTokens} tokens)`
      : 'stale — run `pnpm harness-lint --write` and commit the diff',
  };
};

/** Run every harness check. Pure reporting: a broken manifest fails a check, never throws. */
export const harnessLint = (
  instructionsDir: string,
  permissionsDir: string,
  commandsDir?: string,
  hooksDir?: string,
  skillsDir?: string,
): HarnessReport => {
  const athenaRoot = dirname(fileURLToPath(import.meta.url));
  const resolvedCommandsDir = commandsDir ?? join(athenaRoot, 'commands');
  const resolvedHooksDir = hooksDir ?? join(athenaRoot, 'hooks');
  const resolvedSkillsDir = skillsDir ?? join(athenaRoot, 'skills');
  let coherence: CoherenceFile;
  try {
    coherence = readCoherence(permissionsDir);
  } catch (error) {
    const detail = `unreadable ${COHERENCE_FILE}: ${(error as Error).message}`;
    return {
      findings: [{ name: 'coherence', ok: false, detail }],
      costs: [],
      commandCosts: [],
      echoes: [],
      commandEchoes: [],
      unclaimedDenies: [],
      scorecard: null,
    };
  }
  const costs = bundleCosts(instructionsDir);
  const commands = commandCosts(resolvedCommandsDir);
  const layerEchoes = crossLayerEchoes(instructionsDir);
  const cmdEchoes = commandEchoes(instructionsDir, resolvedCommandsDir);
  const unclaimed = unclaimedDenies(permissionsDir, coherence.claims);
  const scorecard = buildScorecard(
    costs,
    commands,
    coherence,
    unclaimed,
    layerEchoes,
    cmdEchoes,
    resolvedSkillsDir,
  );
  return {
    findings: [
      ...claimChecks(coherence.claims, instructionsDir, permissionsDir),
      ...denySoundnessChecks(permissionsDir, coherence.acknowledgedUnsoundDenies),
      budgetCheck(costs),
      duplicateCheck(instructionsDir),
      commandsManifestCheck(resolvedCommandsDir),
      ...commandFrontmatterChecks(resolvedCommandsDir),
      commandDuplicateCheck(resolvedCommandsDir),
      commandCrossLinkCheck(resolvedCommandsDir),
      hooksManifestCheck(resolvedHooksDir),
      skillsManifestCheck(resolvedSkillsDir),
      ...skillFrontmatterChecks(resolvedSkillsDir),
      skillBudgetCheck(resolvedSkillsDir),
      skillAmbiguityCheck(resolvedSkillsDir),
      ...hooksWiredCheck(permissionsDir),
      ...codexSecretsCheck(permissionsDir),
      scorecardCheck(dirname(resolvedCommandsDir), scorecard),
    ],
    costs,
    commandCosts: commands,
    echoes: layerEchoes,
    commandEchoes: cmdEchoes,
    unclaimedDenies: unclaimed,
    scorecard,
  };
};

/** Write the measured scorecard. The only thing in this module that touches the disk. */
export const writeScorecard = (athenaRoot: string, scorecard: Scorecard): string => {
  const path = join(athenaRoot, SCORECARD_FILE);
  writeFileSync(path, serializeScorecard(scorecard));
  return path;
};

/**
 * The CLI's verdict. Exported because it is the enforcement: `main` runs only against
 * athena's own layers, so this rule is the one part of the exit path a test can reach.
 */
export const anyFailed = (findings: Finding[]): boolean => findings.some((finding) => !finding.ok);

export const printReport = (report: HarnessReport): void => {
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
  if (report.commandCosts.length > 0) {
    console.log('\nSlash commands (installed per repo, loaded on demand):');
    for (const command of report.commandCosts) {
      const name = command.name.padEnd(24);
      console.log(
        `  ${name} ${String(command.estimatedTokens).padStart(5)} tokens  ${command.lines} lines`,
      );
    }
  }
  if (report.echoes.length > 0) {
    console.log(`\nRules stated in more than one layer (${report.echoes.length}):`);
    for (const echo of report.echoes) {
      console.log(`  ${echo.layers.join(' + ')}\n    ${echo.line}`);
    }
  }
  if (report.commandEchoes.length > 0) {
    console.log(`\nLines a command shares with a layer (${report.commandEchoes.length}):`);
    for (const echo of report.commandEchoes) {
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

export const main = (): void => {
  const athenaDir = dirname(fileURLToPath(import.meta.url));
  const report = harnessLint(join(athenaDir, 'instructions'), join(athenaDir, 'permissions'));
  // --write regenerates the committed scorecard, so the numbers land in the PR diff rather
  // than only on the screen of whoever happened to run this.
  const written =
    process.argv.includes('--write') && report.scorecard !== null
      ? writeScorecard(athenaDir, report.scorecard)
      : null;
  if (written !== null) {
    console.log(`wrote ${written}\n`);
  }
  // Re-measure after a write so the printed report and the exit code describe the file that
  // is now on disk, and a real failure still fails the run.
  const final = written
    ? harnessLint(join(athenaDir, 'instructions'), join(athenaDir, 'permissions'))
    : report;
  printReport(final);
  if (anyFailed(final.findings)) {
    process.exitCode = 1;
  }
};

// The CLI entry guard cannot be exercised from a test: the test runner is always
// argv[1], never this module. Excluded so the score measures testable logic.
// Stryker disable next-line all
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
