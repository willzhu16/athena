import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const instructionsDir = join(dirname(fileURLToPath(import.meta.url)), 'instructions');
// Raised 120 -> 135 on 2026-09-17, deliberately and by owner decision, to fit the hooks
// section in 00-universal. The cap exists so that growth is a choice rather than a drift, so
// the number moves in its own reviewed line and never quietly to accommodate a paste.
const LAYER_LINE_CAP = 135;

describe('instruction layers', () => {
  it('allows framework-required default exports in the shared TypeScript rules', () => {
    const ts = readFileSync(join(instructionsDir, '20-stack-ts.md'), 'utf8');
    expect(ts).not.toContain('Named exports only, never default');
    expect(ts).toContain('framework-required default exports');
  });

  it('links shared procedures to their source repos rather than nonexistent consumer paths', () => {
    const universal = readFileSync(join(instructionsDir, '00-universal.md'), 'utf8');
    const security = readFileSync(join(instructionsDir, '10-security.md'), 'utf8');
    expect(universal).toContain(
      'https://github.com/willzhu16/platform/blob/v1/handbook/definition-of-done.md',
    );
    expect(security).toContain('https://github.com/willzhu16/platform/blob/v1/security/README.md');
  });

  it('reaches the review protocol through the shipped skill, not a URL', () => {
    // This used to be a link to review-protocol.md in the athena repo, because the procedure
    // lived somewhere a generated repo could not reach. It ships as a skill now, so the layer
    // names the skill instead: a local file that loads on demand beats a fetch, and it is the
    // reason the review-round limit could leave the always-on layer at all.
    const universal = readFileSync(join(instructionsDir, '00-universal.md'), 'utf8');

    expect(universal).toContain('`review-protocol` skill');
    expect(universal).not.toContain('blob/v1/review-protocol.md');
  });

  it('treats demonstrated correctness and security defects as blocking review findings', () => {
    const review = readFileSync(join(instructionsDir, '../review-protocol.md'), 'utf8');
    expect(review).not.toContain('Blocking findings (only these two)');
    expect(review).toContain('Demonstrated correctness or security defects');
  });

  const layers = readdirSync(instructionsDir).filter((name) => name.endsWith('.md'));

  it('exist', () => {
    expect(layers.length).toBeGreaterThan(0);
  });

  it.each(layers)('%s stays within the %d-line cap', (name) => {
    const lines = readFileSync(join(instructionsDir, name), 'utf8').split('\n').length;
    expect(lines).toBeLessThanOrEqual(LAYER_LINE_CAP);
  });
});
