/**
 * Clean-code and DRY rules shared by every stage that writes or designs code.
 *
 * These live in one place on purpose: the coding stage needs them to write clean
 * code the first time, and the specs/arch stage needs them so its proposal plans
 * for reuse instead of leaving a cleanup pass for later. Two copies of this text
 * would drift, which is the exact failure the rules themselves warn about.
 *
 * Keep this language-agnostic. Project-specific conventions (naming, layering,
 * framework idioms) belong in the spec document, not here — this file ships with
 * the pipeline and runs against every target repo.
 */
export const CODE_QUALITY_RULES = `Clean code and DRY are part of the task, not a follow-up pass.

REUSE BEFORE YOU WRITE
- Before adding a helper, constant, type, or utility, search the repo for one that
  already does the job. Grep the shared/common/util modules first.
- Never hand-roll what an existing shared utility already provides.
- When you do need something new, put it where the existing peers of its kind live
  rather than starting a parallel structure.

REMOVE DUPLICATION YOU CREATE OR TOUCH
- Extract on the second real occurrence, not in anticipation of one. An abstraction
  guessed in advance is harder to remove than the duplication it replaced.
- If the task makes you write a third near-copy of something, stop and extract the
  shared piece first, then use it from all call sites.
- A literal that carries meaning and appears in more than one place becomes a named
  constant. A message string shared by several call sites belongs in one place.
- When you extract, migrate every existing call site you can see, and delete what
  you replaced. Never leave the old private helper behind as dead code.

KEEP COUPLED DECISIONS ADJACENT
- Two pieces of code that must agree should sit together, so they cannot drift.
  Build a condition and bind its parameter in the same statement or method; declare
  a field and its validation together; keep a mapping and its inverse side by side.
- Splitting them across two methods lets a mismatch compile cleanly and only fail at
  runtime. That is a bug waiting, not a style preference.

NEVER INTERPOLATE CALLER INPUT INTO A COMMAND OR QUERY
- Identifiers, column names, sort fields, table names, paths, and shell arguments
  that originate from a request must be validated against an explicit allowlist, or
  passed as a bound parameter. String concatenation of caller-supplied values into
  SQL, a shell command, or a path is never acceptable, even behind an internal API.
- If you extract such logic into shared code, the shared version must be safe by
  construction — do not lift an injection hole into infrastructure that everything
  else will then depend on.

MATCH THE CODE AROUND YOU
- Read the file you are editing and follow its naming, error handling, comment
  density, and idiom. Consistency with neighbours beats your personal preference.
- Comments explain why a choice was made, or record a non-obvious constraint. Do not
  narrate what the next line plainly does.

LEAVE NOTHING HALF-DONE
- No commented-out code, no TODO placeholders, no unused imports or variables, no
  debugging output.
- Do not leave a method, field, or file that nothing references any more.
- If you must leave a real limitation, say so in your summary rather than hiding a
  marker in the source.`;
