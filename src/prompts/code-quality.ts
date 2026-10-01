/**
 * Clean-code, DRY and formatting rules shared by every stage that writes or
 * designs code.
 *
 * These live in one place on purpose: the coding stage needs them to write clean
 * code the first time, and the specs/arch stage needs them so its proposal plans
 * for reuse instead of leaving a cleanup pass for later. Two copies of this text
 * would drift, which is the exact failure the rules themselves warn about.
 *
 * Keep this language-agnostic. Project-specific conventions (naming, layering,
 * framework idioms) belong in the spec document, not here — this file ships with
 * the pipeline and runs against every target repo.
 *
 * That applies to formatting too, which is why the formatting section says to go
 * find and obey the target repo's own formatter rather than naming an indent width
 * here. A concrete style baked into this file would be wrong for every repo that
 * chose differently, and there is no way to tell from here which those are.
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

USE THE PROJECT'S OWN FORMATTER AND LINTER
- Find the formatting setup the project already has before writing code: an
  .editorconfig, a formatter config (Prettier, Biome, Spotless, Checkstyle,
  clang-format, dotnet format, gofmt, black, ktlint), a linter config, or a
  format/lint script in the build file. Obey the one that is there; do not bring
  your own style to a repo that has already decided.
- Run that formatter and linter over the files you changed before you finish, and
  fix what they report about your own code. The task is not done while the code you
  just wrote fails the project's own lint.
- Where no configuration exists, copy the file you are editing: indentation, quote
  style, line width, import order, brace placement.
- Never reformat code you did not otherwise change, and never run a formatter across
  the whole repo. A diff that mixes real changes with unrelated whitespace churn
  cannot be reviewed, and a reviewer who cannot see the change cannot approve it.

LEAVE NOTHING HALF-DONE
- No commented-out code, no TODO placeholders, no unused imports or variables, no
  debugging output.
- Do not leave a method, field, or file that nothing references any more.
- If you must leave a real limitation, say so in your summary rather than hiding a
  marker in the source.

KISS — PREFER THE SIMPLEST THING THAT MEETS THE REQUIREMENT
- Write the plainest implementation that satisfies it. An extra layer of
  indirection, a design pattern, or a new abstraction earns its place by solving
  a concrete problem you have right now, not by how the code might grow later.
- Do not split a straight-line function into a strategy object, factory, or
  plugin system to look more "architected" when nothing yet needs more than one
  case. Fewer moving parts is easier to review, test, and change than a clever
  one.
- Between two approaches that both meet the requirement, pick the one a
  newcomer to this file would understand fastest, not the one that shows off a
  technique.
- Simplicity is about fewer moving parts, not fewer safeguards: still handle the
  real failure cases and follow every other rule here — simple is not the same
  as careless.

YAGNI — BUILD WHAT WAS ASKED, NOT WHAT MIGHT BE NEEDED LATER
- Implement exactly what the task or spec describes. No extra fields,
  endpoints, config flags, or generic hooks for a use case nobody asked for.
- Do not add error handling, retries, or a fallback path for a scenario the
  task does not describe as possible. A guard against an input that cannot
  occur is dead code that only looks like safety.
- Do not turn a single call site into a configurable framework in anticipation
  of a second caller that does not exist yet. Add that flexibility once a real
  second use appears.
- If the work seems to call for more than the task states, say so in your
  summary instead of silently expanding scope — a diff should never contain
  something its reader did not ask for.

KEEP THE PIPELINE GREEN, NOT JUST YOUR OWN COMPILE
- Before finishing, find the project's actual CI config (.github/workflows,
  .gitlab-ci.yml, Jenkinsfile, azure-pipelines.yml, bitbucket-pipelines.yml) and run
  the same build/lint/test commands it runs, with the same flags and working
  directory — not a generic "does it compile". A reactor or workspace build scoped
  with a flag like -pl/--filter/-am behaves differently from building the whole
  tree, and a flag like -DskipTests still requires the main sources to compile even
  though it skips the test phase. A type-checker is not a substitute for this: a
  bundler-based build (esbuild, webpack, vite, and similar) strips types without
  validating them, so it can succeed despite type errors the checker reports, and
  it can fail for a reason the checker has no way to see (a genuinely missing
  export at the module boundary). Run the literal build command the pipeline
  invokes; do not treat a type-check as an equivalent or stricter stand-in for it.
- Match the toolchain version the pipeline actually uses — the image or tag pinned
  in the CI file or the Dockerfile it invokes — not whatever is installed locally.
  A language feature that compiles on a newer local JDK, Node, or similar can fail
  on an older pinned image.
- When you add a new module, package, workspace member, or service, grep for how
  its siblings are already wired in and mirror every place one appears: the
  aggregator build file's module list, a multi-stage Dockerfile's explicit
  copy-and-build steps, workspace glob config, and any path-filtered CI job
  trigger (changes:, paths:, paths-ignore:). An unregistered unit is invisible to
  the build and deploy graph — it will not fail loudly, it will simply never be
  built, tested, or shipped.
- Any dependency you add or upgrade must have its lockfile regenerated and
  committed in the same change. A reproducible-install flag the pipeline uses
  (--frozen-lockfile, npm ci, or similar) fails hard the moment the manifest and
  lockfile disagree — never hand-edit the manifest and leave the lockfile stale.
- If a step you would expect — lint, type-check, unit tests — is disabled or
  missing from the pipeline, that is not permission to skip it. Run the project's
  own declared lint/type-check/test commands yourself before calling the task
  done: a pipeline gap makes your own diligence the only signal left, not a reason
  to relax.
- When your change is one side of a generated or cross-service contract (an
  OpenAPI/gRPC client, a shared type package, a schema another pipeline
  consumes), verify or update the consuming side in the same task, or say plainly
  in your summary that the other side still needs it. A producer whose own build
  stays green can still break a consumer that only finds out at its own build or
  deploy step.
- When you must hand-write a stand-in for a file a generator will eventually
  produce (the real schema is not ready, or you cannot run the generator here),
  do not trust a reasoned guess at its exact names — a generator that
  auto-numbers colliding operation names across controllers (two "search" or
  "delete" methods in different tags) decides the exact suffix itself, not
  something inspection can predict. Say plainly that the stand-in's names are
  unverified, and replace it by actually running the real generator the moment
  the real schema exists, rather than trusting the guess indefinitely. A
  hand-patch left inside an otherwise-generated file is only as durable as the
  next regeneration: sync tooling generally cannot tell which lines you patched,
  and silently overwrites them the moment it touches that file for any reason,
  including an unrelated endpoint. Prefer fixing the root cause the generator
  reads over patching its output — for example a file-upload endpoint whose
  mapping does not declare its request as multipart (Spring: consumes =
  MediaType.MULTIPART_FORM_DATA_VALUE) still type-checks but generates a client
  that cannot upload a file, and fixing that annotation fixes every future
  regeneration instead of one you will have to redo.`;
