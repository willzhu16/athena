import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The athena compiler: turns the canonical instruction layers plus a repo's `.athena`
 * config into the per-tool files each agent reads (CLAUDE.md / AGENTS.md / …). It exists
 * so one source of guidance compiles to whatever format any tool wants (D-16), and so
 * drift is detectable: output is deterministic and carries a content hash.
 */

export interface ReviewConfig {
  enabled: boolean;
  reviewer: unknown;
}

export interface AthenaConfig {
  athenaVersion: string;
  stack: string;
  targets: string[];
  tools: string[];
  /** Permission tier, 0-2. Omitted means DEFAULT_TIER, so existing repos do not drift. */
  tier?: number;
  review?: ReviewConfig;
}

export interface CompileInputs {
  instructionsDir: string;
  permissionsDir: string;
  commandsDir: string;
  hooksDir: string;
  skillsDir: string;
  projectLayer: string;
}

export interface CompiledOutputs {
  hash: string;
  body: string;
  files: Record<string, string>;
}

const MARKER = 'ATHENA-COMPILED';

/** Tools compile knows how to emit files for. An unknown name is a config error, not a fallback. */
export const KNOWN_TOOLS = ['claude', 'codex'] as const;

/**
 * Permission tiers that exist as files: t0 reviewer (read-only), t1 author, t2 author plus
 * preview deploys. A repo picks one with `tier` in its config. Adding a tier is adding the
 * two profile files for it, the same way adding an instruction layer adds a valid stack.
 */
export const KNOWN_TIERS = [0, 1, 2] as const;

/** Used when a config names no tier. t1 was the only behaviour before tiers existed, so
 * defaulting to it means no already-generated repo changes. */
export const DEFAULT_TIER = 1;

/** The tier a config resolves to. */
export const tierOf = (config: AthenaConfig): number => config.tier ?? DEFAULT_TIER;

/** Claude permission profile filename for a tier. */
export const settingsProfileFor = (tier: number): string => `t${tier}.settings.json`;

/** Codex FILE-access profile for a tier, installed at `.codex/config.toml`. */
export const codexProfileFor = (tier: number): string => `codex.t${tier}.config.toml`;

/**
 * Codex COMMAND rules for a tier, installed at `.codex/rules/artemis.rules`. Codex keeps
 * command policy in a separate Starlark file from file access, so one Claude profile maps
 * onto two Codex outputs. Named `artemis.rules` in the target so it cannot collide with a
 * rules file the repo's owner writes themselves.
 */
export const codexRulesFor = (tier: number): string => `codex.t${tier}.rules`;

/** The default profile name, kept for callers that only care about the shipped default. */
export const SETTINGS_PROFILE = settingsProfileFor(DEFAULT_TIER);

/**
 * Slash commands compile installs verbatim into `.claude/commands/` and doctor verifies.
 * Shipping a pattern as a command is what makes it reachable; a process doc in the athena
 * repo is not something an agent working in a generated repo will ever find.
 */
export const COMMANDS = ['conductor.md'] as const;

/**
 * Hook scripts compile installs into `.claude/hooks/`, referenced by the `hooks` block in
 * every permission profile. They are what makes a rule fire on its own instead of waiting
 * for an agent to remember it: the layers can ask for a green gate, but only the Stop hook
 * makes "done" mean the gate actually ran.
 *
 * Deliberately universal. Each script calls the frozen package-script contract (D-18) and
 * detects the toolchain at runtime, so one set of bytes serves every stack and doctor can go
 * on comparing them verbatim.
 */
export const HOOKS = ['gate.mjs'] as const;

/**
 * Skills compile installs into `.claude/skills/<name>/SKILL.md`. Claude Code preloads each
 * skill's DESCRIPTION and loads the body only when it decides the skill applies, so a skill
 * is how procedure reaches an agent without being paid for on every request — the opposite
 * trade from an instruction layer, which is always in context and must therefore stay short.
 *
 * That makes the description the whole mechanism: it is the only part always loaded, and a
 * body nobody routes to might as well not ship. harness-lint prices and polices descriptions
 * for exactly that reason.
 */
export const SKILLS = ['verify-change'] as const;

/** Validate untrusted JSON before either CLI reads fields or constructs layer paths. */
export function validateConfig(value: unknown): asserts value is AthenaConfig {
  const fail = (detail: string): never => {
    throw new Error(`athena: invalid config — ${detail}`);
  };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('must be an object');
  }
  const config = value as Record<string, unknown>;
  if (typeof config.athenaVersion !== 'string' || !/^[^\s<>]+$/.test(config.athenaVersion)) {
    fail('"athenaVersion" must be a non-empty header token');
  }
  const layerName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  if (typeof config.stack !== 'string' || !layerName.test(config.stack)) {
    fail('"stack" must be a layer identifier');
  }
  if (!Array.isArray(config.targets)) fail('"targets" must be an array');
  const targets = config.targets as unknown[];
  if (targets.some((target) => typeof target !== 'string' || !layerName.test(target))) {
    fail('"targets" must contain layer identifiers');
  }
  if (new Set(targets).size !== targets.length) fail('"targets" must be unique');
  if (!Array.isArray(config.tools)) fail('"tools" must be an array');
  const tools = config.tools as unknown[];
  if (tools.length === 0) fail('"tools" must contain at least one tool');
  for (const tool of tools) {
    if (typeof tool !== 'string' || !(KNOWN_TOOLS as readonly string[]).includes(tool)) {
      fail(`unknown tool "${String(tool)}" — known tools: ${KNOWN_TOOLS.join(', ')}`);
    }
  }
  if (new Set(tools).size !== tools.length) fail('"tools" must be unique');
  if (config.tier !== undefined) {
    const tier = config.tier;
    if (typeof tier !== 'number' || !(KNOWN_TIERS as readonly number[]).includes(tier)) {
      fail(`unknown tier "${String(tier)}" — known tiers: ${KNOWN_TIERS.join(', ')}`);
    }
  }
}

/** Instruction layer filenames for a config, in canonical merge order (numeric prefix). */
export const resolveLayers = (config: AthenaConfig): string[] => {
  const layers = ['00-universal.md', '10-security.md', `20-stack-${config.stack}.md`];
  for (const target of config.targets) {
    layers.push(`30-target-${target}.md`);
  }
  return layers;
};

const readLayer = (instructionsDir: string, name: string): string => {
  const path = join(instructionsDir, name);
  if (!existsSync(path)) {
    throw new Error(`athena: instruction layer not found: ${name}`);
  }
  return readFileSync(path, 'utf8').trimEnd();
};

/**
 * Read a permission profile, naming it when absent. Only t1 ships a Codex profile today, so
 * `tier: 0` plus tool `codex` must fail loudly rather than install t1's permissions under a
 * tier that promised something stricter.
 */
const readProfile = (permissionsDir: string, name: string): string => {
  const path = join(permissionsDir, name);
  if (!existsSync(path)) {
    throw new Error(`athena: permission profile not found: ${name}`);
  }
  return readFileSync(path, 'utf8');
};

/** Concatenate the selected layers and the per-repo project layer into the compiled body. */
export const buildBody = (
  config: AthenaConfig,
  instructionsDir: string,
  projectLayer: string,
): string => {
  const parts = resolveLayers(config).map((name) => readLayer(instructionsDir, name));
  parts.push(projectLayer.trimEnd());
  return `${parts.join('\n\n')}\n`;
};

/** Deterministic content hash — no timestamps, so identical inputs give identical output. */
export const computeHash = (body: string): string =>
  createHash('sha256').update(body).digest('hex').slice(0, 16);

const render = (config: AthenaConfig, body: string, hash: string): string => {
  const header =
    `<!-- ${MARKER} ${config.athenaVersion} sha:${hash} — ` +
    'edit .athena/project.md or the athena repo, never this file -->';
  return `${header}\n\n${body}`;
};

/** Split the body back out of a compiled file (everything after the header marker line). */
export const extractBody = (compiled: string): string => {
  const separator = compiled.indexOf('\n\n');
  return separator === -1 ? compiled : compiled.slice(separator + 2);
};

/** Read the declared hash from a compiled file's header, or null if absent. */
export const readDeclaredHash = (compiled: string): string | null => {
  const match = compiled.match(new RegExp(`${MARKER} \\S+ sha:([0-9a-f]+)`));
  return match ? match[1] : null;
};

/** Produce every output file's contents for a config. Pure: performs no filesystem writes. */
export const compile = (config: AthenaConfig, inputs: CompileInputs): CompiledOutputs => {
  validateConfig(config);
  const body = buildBody(config, inputs.instructionsDir, inputs.projectLayer);
  const hash = computeHash(body);
  const compiled = render(config, body, hash);
  const files: Record<string, string> = {};
  const tier = tierOf(config);
  for (const tool of config.tools) {
    if (tool === 'claude') {
      files['CLAUDE.md'] = compiled;
      files['.claude/settings.json'] = readProfile(inputs.permissionsDir, settingsProfileFor(tier));
      for (const command of COMMANDS) {
        files[`.claude/commands/${command}`] = readFileSync(
          join(inputs.commandsDir, command),
          'utf8',
        );
      }
      for (const hook of HOOKS) {
        files[`.claude/hooks/${hook}`] = readFileSync(join(inputs.hooksDir, hook), 'utf8');
      }
      for (const skill of SKILLS) {
        files[`.claude/skills/${skill}/SKILL.md`] = readFileSync(
          join(inputs.skillsDir, skill, 'SKILL.md'),
          'utf8',
        );
      }
    } else if (tool === 'codex') {
      files['AGENTS.md'] = compiled;
      files['.codex/config.toml'] = readProfile(inputs.permissionsDir, codexProfileFor(tier));
      files['.codex/rules/artemis.rules'] = readProfile(inputs.permissionsDir, codexRulesFor(tier));
    }
  }
  return { hash, body, files };
};

const readConfig = (projectDir: string): AthenaConfig =>
  JSON.parse(readFileSync(join(projectDir, '.athena', 'config.json'), 'utf8')) as AthenaConfig;

const readProjectLayer = (projectDir: string): string => {
  const path = join(projectDir, '.athena', 'project.md');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
};

/** Write compiled outputs into the project, creating parent directories as needed. */
export const writeOutputs = (projectDir: string, outputs: CompiledOutputs): string[] => {
  const written: string[] = [];
  for (const [relative, contents] of Object.entries(outputs.files)) {
    const path = join(projectDir, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
    written.push(relative);
  }
  return written;
};

export const main = (): void => {
  const athenaDir = dirname(fileURLToPath(import.meta.url));
  const projectDir = process.argv[2] ?? process.cwd();
  const outputs = compile(readConfig(projectDir), {
    instructionsDir: join(athenaDir, 'instructions'),
    permissionsDir: join(athenaDir, 'permissions'),
    commandsDir: join(athenaDir, 'commands'),
    hooksDir: join(athenaDir, 'hooks'),
    skillsDir: join(athenaDir, 'skills'),
    projectLayer: readProjectLayer(projectDir),
  });
  const written = writeOutputs(projectDir, outputs);
  console.log(
    `athena: compiled ${written.length} file(s) [sha:${outputs.hash}] -> ${written.join(', ')}`,
  );
};

// The CLI entry guard cannot be exercised from a test: the test runner is always
// argv[1], never this module. Excluded so the score measures testable logic.
// Stryker disable next-line all
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
