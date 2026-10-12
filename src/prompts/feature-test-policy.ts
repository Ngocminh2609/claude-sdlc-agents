/**
 * How feature mode verifies code, for the stages that plan the work (Specs &
 * Arch, task breakdown) and the stage that writes it (Coding).
 *
 * Feature-mode Coding does not write persisted unit test files (user decision,
 * 2026-09-28) and does not start the app to try its work (user decision,
 * 2026-10-06 — starting servers was among the heaviest turns of a task): the
 * E2E stage proves the whole feature against the spec in a real browser.
 * Stating that only in the Coding prompt was not enough — on a real run the design and every task description still asked for unit test
 * classes and a full `verify`/`npm test` gate per task, Coding followed the
 * task, and test files made up ~44% of the code written plus 48 build/test runs.
 * The planning stages have to hear the same rule, so it lives here once.
 */
export const FEATURE_TEST_POLICY = `VERIFICATION IN THIS PIPELINE
- Do not plan or write new unit/integration test files (no *Test.java, *.test.ts,
  src/test/ additions, Vitest/Jest suites). An independent end-to-end stage runs
  after all tasks and proves the feature against the spec's acceptance criteria.
- Do not add a test framework or a "test" script to a project that has none.
- A task is verified by: it compiles/builds, and the project's formatter and linter
  pass on the changed files. Do not start the app, a dev server or a database to try
  it, and do not write throwaway scripts to call it — the E2E stage does that.
- If the project already has tests, run the existing suite once at the end of the
  task (not after every edit) to catch regressions.`;
