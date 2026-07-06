import { describe, expect, it } from 'vitest';
import { computeHash } from './compile.ts';
import { isFresh } from './doctor.ts';

const body = '# Layer\n\nreal content\n';
const hash = computeHash(body);
const compiled = `<!-- ATHENA-COMPILED v1 sha:${hash} — do not edit -->\n\n${body}`;

describe('isFresh (drift detection)', () => {
  it('accepts an unmodified compiled file', () => {
    expect(isFresh(compiled, hash)).toBe(true);
  });

  it('rejects a hand-edit below the header', () => {
    // Regression: the header hash stays valid, so trusting it (the old bug) read as fresh.
    const edited = `${compiled}\nsneaky hand edit\n`;
    expect(isFresh(edited, hash)).toBe(false);
  });

  it('rejects stale content when the source layers have changed', () => {
    expect(isFresh(compiled, 'deadbeefdeadbeef')).toBe(false);
  });
});
