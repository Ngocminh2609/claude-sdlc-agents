/**
 * Whether a path is a test file — the boundary between the clone pipeline's
 * test stage and its fix stage.
 *
 * The test stage may write only these, so it cannot patch the code it is
 * testing to make its own tests pass. The fix stage may write anything else,
 * but not these, so it cannot make a failing test pass by weakening it. The
 * same rule on both sides is what keeps "the tests pass" meaning something.
 *
 * Recognised: Maven/Gradle test source trees (`src/test/`), `__tests__/` and
 * `tests/`/`test/` folders, and `*.test.*` / `*.spec.*` files.
 */
export function isTestFile(file: string): boolean {
  const normalised = file.replace(/\\/g, "/");
  return (
    /(^|\/)src\/test\//.test(normalised) ||
    /(^|\/)(__tests__|tests?|__mocks__)\//.test(normalised) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(normalised)
  );
}
