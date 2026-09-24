import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

/**
 * The floors live in their own JSON file so vitest, which enforces them, and harness-lint's
 * ratchet, which holds them one-way, read the same bytes. Restating a threshold in a second
 * file is how the gate and the record come to disagree, and the ratchet is only meaningful if
 * it reads the number that actually enforces.
 */
const thresholds = JSON.parse(
  readFileSync(new URL('./coverage-thresholds.json', import.meta.url), 'utf8'),
);

export default defineConfig({
  test: {
    // Stryker copies the whole project into .stryker-tmp/sandbox-*/ to mutate it. Without
    // this exclude, vitest discovers those copies and runs every test twice — and the
    // coverage report averages the real source together with stale sandbox snapshots.
    // It read as 83% statements while the actual source sat at 98%.
    exclude: ['node_modules/**', '.stryker-tmp/**', 'reports/**'],
    coverage: {
      // cobertura feeds the diff-coverage step in platform's ci.yml, which asks how well the
      // lines THIS pull request changed are covered — the question whole-repo coverage
      // cannot answer once a repo is large enough for new code to be a rounding error.
      reporter: ['text', 'cobertura'],
      // Scoped to the CLI source, so a brand-new untested file counts as 0 rather than
      // being invisible, and config/test files cannot inflate the number.
      include: ['compile.ts', 'doctor.ts', 'harness-lint.ts', 'acceptance.ts'],
      // Floors, ratcheted to the measured numbers and set under them. athena is where the
      // testing standard is written, so it holds itself to the standard it publishes.
      // Lowering one now fails harness-lint's ratchet unless ratchet.json carries an
      // approved override, so the "never lower this" comment is enforced rather than asked.
      thresholds: {
        lines: thresholds.lines,
        functions: thresholds.functions,
        statements: thresholds.statements,
        branches: thresholds.branches,
      },
    },
  },
});
