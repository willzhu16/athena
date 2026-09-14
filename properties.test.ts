import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type AthenaConfig,
  buildBody,
  computeHash,
  extractBody,
  KNOWN_TIERS,
  KNOWN_TOOLS,
  readDeclaredHash,
  validateConfig,
} from './compile.ts';
import { canonicalJson, isFresh, sameJson } from './doctor.ts';
import { normalizeLine } from './harness-lint.ts';

/**
 * Property-based tests: instead of naming three inputs, these state a rule and let
 * fast-check attack it with hundreds. They live in one file rather than beside each module
 * because the seed is configured once here, and because what they cover is an invariant
 * that spans compile and doctor rather than either one alone.
 *
 * The seed is fixed on purpose. A random seed would make the mutation score move between
 * runs, which is the one thing a ratcheted floor cannot tolerate, and would turn a real
 * failure into one nobody can reproduce. Explore more by raising numRuns or changing the
 * seed deliberately — a failure prints the counterexample and the seed that found it.
 */
fc.configureGlobal({ seed: 20260914, numRuns: 300 });

const athenaRoot = dirname(fileURLToPath(import.meta.url));
const instructionsDir = join(athenaRoot, 'instructions');

/** The compiled shape doctor reads: header line, blank line, body. */
const compiled = (body: string, hash: string): string =>
  `<!-- ATHENA-COMPILED v1 sha:${hash} — do not edit -->\n\n${body}`;

describe('drift detection holds for any content, not just the samples', () => {
  it('reports a file as fresh when its body is the one that was hashed', () => {
    fc.assert(
      fc.property(fc.string(), (body) => {
        expect(isFresh(compiled(body, computeHash(body)), computeHash(body))).toBe(true);
      }),
    );
  });

  it('reports drift whenever the body is not the one that was hashed', () => {
    // The claim the whole harness rests on: a repo whose instructions were changed, by any
    // edit at all, cannot report fresh.
    fc.assert(
      fc.property(fc.string(), fc.string(), (body, other) => {
        fc.pre(body !== other);
        expect(isFresh(compiled(body, computeHash(other)), computeHash(other))).toBe(false);
      }),
    );
  });

  it('recovers the body from the compiled file byte for byte', () => {
    fc.assert(
      fc.property(fc.string(), (body) => {
        expect(extractBody(compiled(body, computeHash(body)))).toBe(body);
      }),
    );
  });

  it('reads back the hash it stamped into the header', () => {
    fc.assert(
      fc.property(fc.string(), (body) => {
        const hash = computeHash(body);
        expect(readDeclaredHash(compiled(body, hash))).toBe(hash);
      }),
    );
  });

  it('gives the same hash for the same input, every time', () => {
    // Determinism is what lets the hash mean "unchanged" rather than "recompiled".
    fc.assert(
      fc.property(fc.string(), (body) => {
        expect(computeHash(body)).toBe(computeHash(body));
      }),
    );
  });
});

describe('settings comparison ignores formatting and nothing else', () => {
  it('treats key order as meaningless', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (object) => {
        const reordered = Object.fromEntries(Object.entries(object).reverse());
        expect(canonicalJson(reordered)).toBe(canonicalJson(object));
      }),
    );
  });

  it('treats array order as meaningful, because a permission list is not a set', () => {
    fc.assert(
      fc.property(fc.array(fc.jsonValue(), { minLength: 2 }), (items) => {
        const reversed = [...items].reverse();
        // Skip the cases where reversing changed nothing that canonicalises differently:
        // [{a:1,b:2}, {b:2,a:1}] really is the same list twice.
        fc.pre(
          canonicalJson(items.map(canonicalJson)) !== canonicalJson(reversed.map(canonicalJson)),
        );
        expect(canonicalJson(reversed)).not.toBe(canonicalJson(items));
      }),
    );
  });

  it('calls any document equal to itself, however it was spelled', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(sameJson(JSON.stringify(value), JSON.stringify(value, null, 4))).toBe(true);
      }),
    );
  });

  it('produces a canonical form that is already canonical', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const once = canonicalJson(value);
        expect(canonicalJson(JSON.parse(once))).toBe(once);
      }),
    );
  });
});

const alphanumeric = fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split(''));
const segment = fc
  .array(alphanumeric, { minLength: 1, maxLength: 6 })
  .map((characters) => characters.join(''));
/** A layer identifier the way the validator's grammar defines one: lowercase, dash-joined. */
const layerIdentifier = fc
  .array(segment, { minLength: 1, maxLength: 3 })
  .map((segments) => segments.join('-'));

const validConfig = fc.record(
  {
    athenaVersion: fc.constantFrom('v1', 'v2', 'v1.4.0'),
    stack: layerIdentifier,
    targets: fc.uniqueArray(layerIdentifier, { maxLength: 3 }),
    tools: fc.uniqueArray(fc.constantFrom(...KNOWN_TOOLS), { minLength: 1 }),
    tier: fc.option(fc.constantFrom(...KNOWN_TIERS), { nil: undefined }),
  },
  { requiredKeys: ['athenaVersion', 'stack', 'targets', 'tools'] },
);

describe('config validation accepts its own grammar', () => {
  it('accepts every config the grammar allows', () => {
    // The failure this guards against is a validator that is stricter than the documented
    // shape, which surfaces as a repo that cannot be compiled for no stated reason.
    fc.assert(
      fc.property(validConfig, (config) => {
        expect(() => validateConfig(config)).not.toThrow();
      }),
    );
  });

  it('rejects any tool outside the known list', () => {
    fc.assert(
      fc.property(validConfig, fc.string(), (config, tool) => {
        fc.pre(!(KNOWN_TOOLS as readonly string[]).includes(tool));
        expect(() => validateConfig({ ...config, tools: [tool] })).toThrow(/unknown tool/);
      }),
    );
  });

  it('rejects a duplicated target whatever the identifier is', () => {
    fc.assert(
      fc.property(layerIdentifier, (target) => {
        const config = {
          athenaVersion: 'v1',
          stack: 'ts',
          targets: [target, target],
          tools: ['claude'],
        };
        expect(() => validateConfig(config)).toThrow(/"targets" must be unique/);
      }),
    );
  });
});

describe('the project layer always reaches the bundle', () => {
  it('ends every bundle with the project notes, whatever they say', () => {
    // A repo's own rules are the part with no fleet-wide backup. If they were ever dropped
    // on the way into the bundle, the agent would silently work without them.
    const config: AthenaConfig = {
      athenaVersion: 'v1',
      stack: 'ts',
      targets: [],
      tools: ['claude'],
    };
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).map((text) => `${text}x`),
        (projectLayer) => {
          expect(buildBody(config, instructionsDir, projectLayer).trimEnd()).toContain(
            projectLayer.trimEnd(),
          );
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe('rule-line normalisation', () => {
  it('is idempotent, so two spellings of one rule compare equal once', () => {
    fc.assert(
      fc.property(fc.string(), (line) => {
        const once = normalizeLine(line);
        expect(normalizeLine(once)).toBe(once);
      }),
    );
  });
});
