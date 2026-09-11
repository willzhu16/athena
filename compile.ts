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
  review?: ReviewConfig;
}

export interface CompileInputs {
  instructionsDir: string;
  permissionsDir: string;
  commandsDir: string;
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

/** The permission profile compile installs and doctor verifies — one name, two consumers. */
export const SETTINGS_PROFILE = 't1.settings.json';

/**
 * Slash commands compile installs verbatim into `.claude/commands/` and doctor verifies.
 * Shipping a pattern as a command is what makes it reachable; a process doc in the athena
 * repo is not something an agent working in a generated repo will ever find.
 */
export const COMMANDS = ['conductor.md'] as const;

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
  for (const tool of config.tools) {
    if (!(KNOWN_TOOLS as readonly string[]).includes(tool)) {
      throw new Error(
        `athena: unknown tool "${tool}" in config.tools — known tools: ${KNOWN_TOOLS.join(', ')}`,
      );
    }
  }
  const body = buildBody(config, inputs.instructionsDir, inputs.projectLayer);
  const hash = computeHash(body);
  const compiled = render(config, body, hash);
  const files: Record<string, string> = {};
  for (const tool of config.tools) {
    if (tool === 'claude') {
      files['CLAUDE.md'] = compiled;
      files['.claude/settings.json'] = readFileSync(
        join(inputs.permissionsDir, SETTINGS_PROFILE),
        'utf8',
      );
      for (const command of COMMANDS) {
        files[`.claude/commands/${command}`] = readFileSync(
          join(inputs.commandsDir, command),
          'utf8',
        );
      }
    } else if (tool === 'codex') {
      files['AGENTS.md'] = compiled;
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

const main = (): void => {
  const athenaDir = dirname(fileURLToPath(import.meta.url));
  const projectDir = process.argv[2] ?? process.cwd();
  const outputs = compile(readConfig(projectDir), {
    instructionsDir: join(athenaDir, 'instructions'),
    permissionsDir: join(athenaDir, 'permissions'),
    commandsDir: join(athenaDir, 'commands'),
    projectLayer: readProjectLayer(projectDir),
  });
  const written = writeOutputs(projectDir, outputs);
  console.log(
    `athena: compiled ${written.length} file(s) [sha:${outputs.hash}] -> ${written.join(', ')}`,
  );
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
