import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type Finding, harnessLint, ratchetFindings } from './harness-lint.ts';

/**
 * Every other test in this repo proves a check works by handing it a fixture built for the
 * occasion. That proves the function is correct. It does not prove the harness ACTUALLY
 * SHIPPED is wired into that function, and the difference is where the failures have been:
 * an empty `floors` map made the ratchet report nothing at all, and the acceptance workflow
 * pointed at one file while the tool could read a directory. Both times every unit test
 * stayed green, because the fixtures were fine and the shipped wiring was not.
 *
 * So these start from the real layers, profiles, commands, hooks and skills, copy them, break
 * one thing a person would plausibly break, and require a named check to go red. A gate that
 * stopped biting looks exactly like a clean run, and this is the only thing that tells them
 * apart.
 *
 * The last test in the file is the one that keeps the rest honest: it fails when a check
 * family exists with no weakening listed for it, so a new gate cannot ship without a proof
 * that it catches something.
 */

const athenaDir = dirname(fileURLToPath(import.meta.url));

/** Everything the harness reads. Copied whole, so a weakening can never reach the real one. */
const COPIED_DIRS = ['instructions', 'permissions', 'commands', 'hooks', 'skills'] as const;
const COPIED_FILES = [
  // conductor.md is the process doc the cross-link check pairs with commands/conductor.md.
  'conductor.md',
  'harness-scorecard.json',
  'ratchet.json',
  'stryker.config.json',
  'coverage-thresholds.json',
] as const;

const shippedCopy = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'athena-weakening-'));
  for (const dir of COPIED_DIRS) {
    cpSync(join(athenaDir, dir), join(root, dir), { recursive: true });
  }
  for (const file of COPIED_FILES) {
    cpSync(join(athenaDir, file), join(root, file));
  }
  return root;
};

/**
 * Every finding the harness produces about ONE root.
 *
 * harnessLint resolves the ratchet against its own module location rather than the
 * directories it is handed, so its ratchet findings describe the real athena, not the copy.
 * They are dropped and re-measured here. Without that swap a hollowed-out ratchet.json in the
 * copy would read as healthy, because the genuine one sitting beside this file is fine, and
 * the weakening would look caught when nothing had been checked.
 */
const findingsFor = (root: string): Finding[] => [
  ...harnessLint(
    join(root, 'instructions'),
    join(root, 'permissions'),
    join(root, 'commands'),
    join(root, 'hooks'),
    join(root, 'skills'),
  ).findings.filter((finding) => !finding.name.startsWith('ratchet')),
  ...ratchetFindings(root),
];

const edit = (path: string, change: (text: string) => string): void => {
  writeFileSync(path, change(readFileSync(path, 'utf8')));
};

const editJson = (path: string, change: (value: Record<string, unknown>) => void): void => {
  const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  change(value);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

const descriptionOf = (source: string): string =>
  source.split('\n').find((line) => line.startsWith('description:')) ?? '';

/** Long enough to count as a rule rather than as document structure. */
const LONG_RULE = 'never force-push a shared branch, not even to tidy the history up';

interface Weakening {
  /** What someone would plausibly do, said as the change rather than as the mechanism. */
  what: string;
  weaken: (root: string) => void;
  /** The exact check that must go red. Asserted by name: a red run is not enough. */
  caught: string;
}

const WEAKENINGS: Weakening[] = [
  {
    what: 'a skill directory that ships to nobody',
    weaken: (root) => {
      mkdirSync(join(root, 'skills', 'rogue'));
      writeFileSync(
        join(root, 'skills', 'rogue', 'SKILL.md'),
        '---\ndescription: an extra nobody lists\n---\n\nbody\n',
      );
    },
    caught: 'skills manifest',
  },
  {
    what: 'a skill whose description was edited away, leaving the body unreachable',
    weaken: (root) =>
      edit(join(root, 'skills', 'verify-change', 'SKILL.md'), (text) =>
        text.replace(/^description:.*$/m, 'summary: no longer the key Claude Code routes on'),
      ),
    caught: 'skill verify-change',
  },
  {
    what: 'skill descriptions grown until the always-on cost stops being small',
    weaken: (root) =>
      edit(join(root, 'skills', 'verify-change', 'SKILL.md'), (text) =>
        text.replace(
          /^description:.*$/m,
          `description: ${'a capability this covers, '.repeat(90)}`,
        ),
      ),
    caught: 'skill descriptions',
  },
  {
    what: 'two skills claiming the same ground, so routing between them is a coin flip',
    weaken: (root) => {
      const borrowed = descriptionOf(
        readFileSync(join(root, 'skills', 'verify-change', 'SKILL.md'), 'utf8'),
      );
      edit(join(root, 'skills', 'write-a-packet', 'SKILL.md'), (text) =>
        text.replace(/^description:.*$/m, borrowed),
      );
    },
    caught: 'skill ambiguity',
  },
  {
    what: 'a hook script sitting in hooks/ that compile never installs',
    weaken: (root) => writeFileSync(join(root, 'hooks', 'rogue.mjs'), 'process.exitCode = 0;\n'),
    caught: 'hooks manifest',
  },
  {
    what: 'a profile that quietly stopped running the stop gate',
    weaken: (root) =>
      editJson(join(root, 'permissions', 't1.settings.json'), (profile) => {
        profile.hooks = {};
      }),
    caught: 'hooks wired t1',
  },
  {
    what: 'a command file in commands/ that COMMANDS does not list',
    weaken: (root) =>
      writeFileSync(join(root, 'commands', 'rogue.md'), '---\ndescription: x\n---\n\nbody\n'),
    caught: 'commands manifest',
  },
  {
    what: 'a command that lost its frontmatter and so installs unlabelled',
    weaken: (root) =>
      edit(join(root, 'commands', 'conductor.md'), (text) =>
        text.replace(/^---\n[\s\S]*?\n---\n/, ''),
      ),
    caught: 'command conductor.md',
  },
  {
    what: 'a command stating one rule twice',
    weaken: (root) =>
      edit(join(root, 'commands', 'conductor.md'), (text) =>
        [text, LONG_RULE, LONG_RULE, ''].join('\n'),
      ),
    caught: 'command duplicates',
  },
  {
    what: 'a process doc that stopped pointing at the command it describes',
    weaken: (root) =>
      edit(join(root, 'conductor.md'), (text) =>
        text.replaceAll('commands/conductor.md', 'the conductor command'),
      ),
    caught: 'command cross-links',
  },
  {
    what: 'a layer grown past what every request can afford to carry',
    weaken: (root) =>
      edit(join(root, 'instructions', '00-universal.md'), (text) =>
        [text, 'Filler that costs real tokens on every single request. '.repeat(120), ''].join(
          '\n',
        ),
      ),
    caught: 'bundle budget',
  },
  {
    what: 'one rule stated twice inside the same bundle, paid for twice per request',
    weaken: (root) =>
      edit(join(root, 'instructions', '00-universal.md'), (text) =>
        [text, LONG_RULE, LONG_RULE, ''].join('\n'),
      ),
    caught: 'bundle duplicates',
  },
  {
    what: 'a layer that stopped stating a command the profile still walls off',
    weaken: (root) =>
      edit(join(root, 'instructions', '10-security.md'), (text) =>
        text.replaceAll('sops -d', 'the decrypt command'),
      ),
    caught: 'claim sops -d',
  },
  {
    what: 'an evadable deny rule that nobody wrote an acknowledgement for',
    weaken: (root) =>
      editJson(join(root, 'permissions', 't1.settings.json'), (profile) => {
        (profile.permissions as { deny: string[] }).deny.push('Bash(curl --output-dir:*)');
      }),
    caught: 'deny soundness (t1)',
  },
  {
    what: 'a codex profile that stopped denying the secret files its claude twin denies',
    weaken: (root) =>
      edit(join(root, 'permissions', 'codex.t1.config.toml'), (text) =>
        text
          .split('\n')
          .filter((line) => !line.includes('.env'))
          .join('\n'),
      ),
    caught: 'codex t1 secret denials',
  },
  {
    what: 'a committed scorecard that no longer matches what the harness measures',
    weaken: (root) =>
      editJson(join(root, 'harness-scorecard.json'), (scorecard) => {
        const bundles = scorecard.bundles as { worstCase: { estimatedTokens: number } };
        bundles.worstCase.estimatedTokens += 100;
      }),
    caught: 'harness-scorecard.json',
  },
  {
    what: 'a quality floor loosened with nobody signing for it',
    weaken: (root) =>
      editJson(join(root, 'stryker.config.json'), (config) => {
        (config.thresholds as { break: number }).break = 50;
      }),
    caught: 'ratchet mutationBreak',
  },
  {
    what: 'a ratchet record with nothing left in it to hold',
    weaken: (root) =>
      editJson(join(root, 'ratchet.json'), (record) => {
        record.floors = {};
      }),
    caught: 'ratchet',
  },
];

/**
 * Check families, matched in order so the specific names win before the general shapes. A
 * name matching none of these is a check nobody classified, which the last test treats as a
 * failure rather than as something to skip.
 */
const FAMILIES: RegExp[] = [
  /^claim /,
  /^deny soundness \(t\d\)$/,
  /^bundle budget$/,
  /^bundle duplicates$/,
  /^commands manifest$/,
  /^command duplicates$/,
  /^command cross-links$/,
  /^command \S+$/,
  /^hooks manifest$/,
  /^hooks wired t\d$/,
  /^skills manifest$/,
  /^skill descriptions$/,
  /^skill ambiguity$/,
  /^skill \S+$/,
  /^codex t\d secret denials$/,
  /^ratchet\b/,
  /^harness-scorecard\.json$/,
];

const familyOf = (name: string): RegExp | undefined => FAMILIES.find((family) => family.test(name));

describe('the shipped harness, weakened one thing at a time', () => {
  it('has nothing to report before anything is broken', () => {
    // Every case below asserts that a named check goes red. That means nothing unless the
    // copy is green to begin with, so this is the baseline the rest of the file stands on.
    const root = shippedCopy();
    try {
      const failed = findingsFor(root).filter((finding) => !finding.ok);

      expect(failed.map((finding) => `${finding.name} — ${finding.detail}`)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(WEAKENINGS.map((weakening) => [weakening.what, weakening] as const))(
    'catches %s',
    (_what, weakening) => {
      const root = shippedCopy();
      try {
        weakening.weaken(root);
        const failed = findingsFor(root).filter((finding) => !finding.ok);

        // By name, not merely "something went red". A weakening caught by the wrong check is
        // a check that has stopped doing its own job while another one covers for it, and the
        // day that other one moves, this goes silent.
        expect(failed.map((finding) => finding.name)).toContain(weakening.caught);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

describe('the weakening table covers every gate', () => {
  it('classifies every check the shipped harness reports', () => {
    // An unclassified name is a check family nobody thought about, and the coverage test
    // below would skip it in silence rather than notice it.
    const root = shippedCopy();
    try {
      const unclassified = findingsFor(root)
        .map((finding) => finding.name)
        .filter((name) => familyOf(name) === undefined);

      expect(unclassified).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lists a weakening for every check family that ships', () => {
    // The point of the whole file. A new gate with no weakening beside it is a gate nobody
    // has watched fail, and this is what refuses to let one ship that way.
    const root = shippedCopy();
    try {
      const shipped = new Set(
        findingsFor(root)
          .map((finding) => familyOf(finding.name)?.source)
          .filter((source): source is string => source !== undefined),
      );
      const proven = new Set(
        WEAKENINGS.map((weakening) => familyOf(weakening.caught)?.source).filter(
          (source): source is string => source !== undefined,
        ),
      );
      const unproven = [...shipped].filter((family) => !proven.has(family));

      expect(unproven).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
