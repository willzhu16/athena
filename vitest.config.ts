import { defineConfig } from 'vitest/config';

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
      // Never lower one to turn a red build green — add the missing test.
      // Measured 2026-09-16: 98.84 statements, 96.29 branches, 100 functions, 98.73 lines.
      thresholds: { lines: 95, functions: 95, statements: 95, branches: 93 },
    },
  },
});
