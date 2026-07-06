import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const instructionsDir = join(dirname(fileURLToPath(import.meta.url)), 'instructions');
const LAYER_LINE_CAP = 120;

describe('instruction layers', () => {
  const layers = readdirSync(instructionsDir).filter((name) => name.endsWith('.md'));

  it('exist', () => {
    expect(layers.length).toBeGreaterThan(0);
  });

  it.each(layers)('%s stays within the %d-line cap', (name) => {
    const lines = readFileSync(join(instructionsDir, name), 'utf8').split('\n').length;
    expect(lines).toBeLessThanOrEqual(LAYER_LINE_CAP);
  });
});
