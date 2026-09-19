import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The gate hook is the only part of the harness that runs inside an agent's loop rather than
 * in CI, so it is the only part whose failure is silent: a hook that exits 0 on a red repo
 * looks exactly like a hook that found nothing wrong. These tests run the real script through
 * real node against real pnpm, because the thing worth proving is the exit code it hands back
 * to Claude Code, and no mock of pnpm would prove that.
 *
 * The hook is node rather than shell for a reason these tests found: spawning `bash` on this
 * Windows host resolves to WSL's bash, which cannot read the Windows path Claude Code passes,
 * so the shell version failed to run on the machine the owner actually works from.
 */

const hookPath = join(dirname(fileURLToPath(import.meta.url)), 'hooks', 'gate.mjs');

/** A Stop payload. `stop_hook_active` true is Claude Code saying "you already blocked once". */
const stopPayload = (alreadyActive: boolean): string =>
  JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: alreadyActive });

interface HookResult {
  status: number;
  stderr: string;
}

const runHook = (projectDir: string, payload: string): HookResult => {
  const result = spawnSync(process.execPath, [hookPath], {
    input: payload,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  });
  if (result.error) throw result.error;
  return { status: result.status ?? -1, stderr: result.stderr };
};

/**
 * A project whose gate outcome is decided by its package scripts. pnpm runs a script without
 * an install, so `exit 1` is a genuinely failing lint with no fixture repo to maintain.
 * Single commands only: pnpm's script runner does not interpret `;` on every platform.
 */
const withProject = (
  scripts: Record<string, string>,
  assert: (projectDir: string) => void,
): void => {
  const projectDir = mkdtempSync(join(tmpdir(), 'athena-hook-'));
  try {
    writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'probe', scripts }));
    assert(projectDir);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
};

// Sequential, with a timeout well above the default. Four of these spawn a real pnpm, and
// pnpm cold-starting under parallel load took 5.3s on this machine — past vitest's 5s
// default, which failed the whole file for timing rather than for behaviour. A flaky gate
// test is worse than none: it teaches people to rerun until green.
describe.sequential('the gate hook decides whether an agent may call its work done', {
  timeout: 30_000,
}, () => {
  it('lets the turn end when lint and typecheck both pass', () => {
    withProject({ lint: 'exit 0', typecheck: 'exit 0' }, (projectDir) => {
      expect(runHook(projectDir, stopPayload(false)).status).toBe(0);
    });
  });

  it('blocks the turn when lint fails', () => {
    // Exit 2 is the code Stop honours. Any other non-zero exit is a hook that errored, which
    // Claude Code ignores — so asserting "not 0" would pass for a hook that does nothing.
    withProject({ lint: 'exit 1', typecheck: 'exit 0' }, (projectDir) => {
      expect(runHook(projectDir, stopPayload(false)).status).toBe(2);
    });
  });

  it('blocks the turn when lint passes but typecheck fails', () => {
    // The second half of the gate has to run too. A hook that stopped after a green lint
    // would pass the test above and still wave through every type error.
    withProject({ lint: 'exit 0', typecheck: 'exit 1' }, (projectDir) => {
      expect(runHook(projectDir, stopPayload(false)).status).toBe(2);
    });
  });

  it('tells the agent the gate is red instead of blocking silently', () => {
    // Exit 2 alone would stop the turn with no reason attached, which reads to an agent as
    // an unexplained failure. stderr is the message it gets.
    withProject({ lint: 'exit 1', typecheck: 'exit 0' }, (projectDir) => {
      expect(runHook(projectDir, stopPayload(false)).stderr).toContain('gate is red');
    });
  });

  it('stops blocking on the second pass, so a red gate cannot loop forever', () => {
    // Blocking a stop sends the agent back to work, which ends in another Stop. Without this
    // guard a permanently red repo would never let the agent finish a turn.
    withProject({ lint: 'exit 1', typecheck: 'exit 0' }, (projectDir) => {
      expect(runHook(projectDir, stopPayload(true)).status).toBe(0);
    });
  });

  it('reads the loop guard whatever whitespace the payload uses', () => {
    // The hook matches the flag without a JSON parser, so that no repo needs jq installed for
    // its own gate to work. That tradeoff is only safe if the match survives normal spacing.
    withProject({ lint: 'exit 1', typecheck: 'exit 0' }, (projectDir) => {
      const spaced = '{"hook_event_name":"Stop", "stop_hook_active" : true}';
      expect(runHook(projectDir, spaced).status).toBe(0);
    });
  });

  it('lets the turn end in a repo it does not recognise', () => {
    // A gate that could not run has proved nothing. Failing closed here would strand any
    // repo that is neither pnpm nor uv rather than catch a defect in it.
    const projectDir = mkdtempSync(join(tmpdir(), 'athena-hook-'));
    try {
      expect(runHook(projectDir, stopPayload(false)).status).toBe(0);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
