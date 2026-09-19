#!/usr/bin/env node
// The universal stop gate.
//
// Claude Code runs this on the Stop event, when an agent is about to end its turn. It runs
// the repo's own lint and typecheck and blocks the stop while either is red, so "done" means
// the gate ran rather than that the agent believed it would pass. Blocking on Stop rather
// than after every edit is deliberate: an intermediate broken state during a multi-file
// change is normal, and a hook firing on each edit interrupts the work it exists to protect.
//
// Written in Node, not bash, because a hook runs wherever the agent runs. On a Windows host
// `bash` resolves to WSL's bash, which cannot read the Windows path Claude Code passes, so a
// shell hook would fail to run on exactly the machine the owner works from — a gate that
// looks installed and never fires, which is worse than having no gate. Node ships with
// Claude Code itself, so it is the one interpreter guaranteed to be present.
//
// Universal by construction: it calls the frozen package-script contract (lint / typecheck,
// D-18) instead of naming any tool, so one file serves a pnpm repo and a uv one.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_REPORTED_LINES = 40;

const readStdin = () => {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
};

/** The Stop payload, or an empty object when stdin is absent or not JSON. */
const readPayload = () => {
  try {
    return JSON.parse(readStdin());
  } catch {
    return {};
  }
};

/**
 * Commands that decide the gate, chosen by what the repo actually is. A repo athena does not
 * recognise, or a machine without the toolchain, yields none: a gate that could not run has
 * proved nothing, and failing closed would strand anyone whose environment differs rather
 * than catch a defect.
 */
const gateCommands = (projectDir) => {
  if (existsSync(join(projectDir, 'package.json'))) {
    return [
      ['pnpm', ['lint']],
      ['pnpm', ['typecheck']],
    ];
  }
  if (existsSync(join(projectDir, 'pyproject.toml'))) {
    return [
      ['uv', ['run', 'ruff', 'check', '.']],
      ['uv', ['run', 'pyright']],
    ];
  }
  return [];
};

const main = () => {
  // Stop hooks re-enter: blocking a stop sends the agent back to work, which ends in another
  // Stop. `stop_hook_active` is true on that second pass, and letting it through is what
  // keeps a red gate from becoming an infinite loop. The agent has been told once; what to do
  // about a gate that stays red is a human's call, not another lap.
  if (readPayload().stop_hook_active === true) return 0;

  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  if (!existsSync(projectDir)) return 0;

  for (const [command, args] of gateCommands(projectDir)) {
    // shell:true because pnpm and uv are .cmd shims on Windows. The command and its
    // arguments are constants above — nothing from the payload reaches this call.
    const result = spawnSync(command, args, {
      cwd: projectDir,
      encoding: 'utf8',
      shell: true,
    });
    // A missing toolchain is not a red gate. Same reasoning as an unrecognised repo.
    if (result.error) return 0;
    if (result.status === 0) continue;

    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
      .split('\n')
      .slice(-MAX_REPORTED_LINES)
      .join('\n');
    // Exit 2 is the code Stop honours, and stderr becomes the reason the agent is told to
    // keep working. The line bound matches 00-universal's rule on reading command output:
    // the last lines of a failing gate are the diagnosis, everything above is noise.
    process.stderr.write(
      'The repo gate is red, so this work is not done. Fix it, or say plainly that it fails.\n\n' +
        `${command} ${args.join(' ')}\n${output}\n`,
    );
    return 2;
  }
  return 0;
};

process.exitCode = main();
