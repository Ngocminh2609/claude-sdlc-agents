# Project conventions

- TypeScript, ESM (`NodeNext`), strict mode. No CommonJS.
- Each pipeline stage in `src/stages/` is a small, independent function — do not
  add a generic `runStage()` abstraction unless real duplication justifies it.
- This tool never touches git — no branch, commit, or push, anywhere in the
  codebase. If you're tempted to add one, that's a sign the requirement
  changed and needs a new decision, not a quiet addition.
- Any change to a stage's `allowedTools`/`disallowedTools`/`canUseTool` is a
  security-relevant change: re-check it against the separation-of-duties
  intent (E2E cannot edit application source, only `e2e/`/`*.spec.ts`/
  `playwright.config.*`; Coding cannot run git-mutating commands) before
  merging.
- The Coding stage runs once per task from `breakDownTasks`, sequentially —
  don't parallelize without reconsidering file-conflict risk first.
- Each Coding session is fresh, so anything the tasks must agree on has to be
  passed in explicitly: the spec, the approved design, and the summaries of
  tasks already done in that pass. Adding a cross-task assumption without
  adding it to that prompt is how two sessions end up naming one endpoint
  two different ways.
- Feature mode's Coding stage does not write persisted unit test files (user
  decision, 2026-09-28) — it verifies its own task by exercising the main flow
  directly (run the app, hit the endpoint, invoke the function) and relies on
  E2E/QA, right after it, to independently prove the whole feature against the
  spec's acceptance criteria through a real browser. This is deliberately
  scoped to feature mode only: clone mode's Clone Tests stage (mocked
  CRUD unit tests) stays as-is, because clone mode does not run E2E at all
  (freshly ported code usually cannot start on its own — see clone mode's own
  "Two honest limits") and would otherwise have no functional check beyond
  "does it compile". Do not remove Clone Tests on the strength of this
  decision; that is a separate call the user has not made.
- Clone mode (`src/clone-pipeline.ts`) is a second pipeline, not a flag on the
  first. Keep it that way: a port has no design to approve and a feature has no
  file mapping to verify, and merging them would give both a set of stages that
  do nothing on half the runs.
- A clone run reports `done` only when coverage is complete and the build
  passed. `incomplete` is a real, expected outcome — never widen it into `done`
  to make a run look better; the ported files are on disk either way and the
  point of the status is to say which of the two happened.
- `checkCoverage` stays deterministic. It is the one answer in this repo that
  does not come from a model, which is exactly where its value is — if it ever
  needs judgement, that judgement belongs in a separate stage, not in there.
  Declared deviations from the port agents feed it, but it only trusts what the
  filesystem backs (a `merged` claim needs its `coveredBy` file on disk). Do not
  reintroduce a "generated later" deviation: it let pages ship importing API
  clients that did not exist.
- A `CloneMappingEntry.notPorted` entry (a mapping-time "do not port this source
  file" decision — a duplicate sibling variant, something superseded by an
  existing equivalent) is excluded from `checkCoverage`'s present/missing
  bookkeeping entirely, not counted missing — that is the whole point of the
  field. It happened for real that Clone Mapping, with no clean way to express
  "no target applies", wrote prose into `target` instead (`"(none — not
  ported)"`), and `checkCoverage`, reading `target` literally as a path,
  correctly-but-wrongly counted every one as a missing file. Never let a future
  "clean up the schema" pass merge `notPorted` back into `uncertain` or drop it
  in favour of free text in `target` — `uncertain` means "porting this, not sure
  where"; `notPorted` means "not porting this at all", and coverage needs to
  tell the two apart mechanically, not by parsing prose. `portGroups` also skips
  a group that is nothing but `notPorted` entries, so Clone Port is never asked
  to spend a turn budget reporting there was no work in it.
- `checkWiring` (`src/clone-wiring.ts`) is the same kind of check for the
  client↔server seam: imports resolve, API paths hit a controller. Keep it
  deterministic and lenient on matching — a false "not wired" on a correct port
  is worse than missing an exotic route.
- Clone port order is enforced by `portGroups` (db → be → fe, via `layerOf`), not
  trusted to the mapping's listing. Client groups are written against
  `portedServerApi`, which is read from disk. Keep that input deterministic.
- The test stage writes only `isTestFile` paths, and the fix stage writes
  everything except them. Do not widen either guard. That split is what makes a
  passing test mean something.
- Bump `CLONE_PLAN_VERSION` in `src/clone-pipeline.ts` when the mapping's contract
  changes, so a mapping saved under old rules is not resumed.
- The project index (`src/project-index.ts`) is plain code and refreshed from git
  every run. Stages get it through `indexPromptSection` + `withIndexAccess`.
  Cached stage answers (`src/stage-cache.ts`) are keyed on `repoVersions`, which
  is HEAD plus uncommitted state. Never key a cache on something looser than the
  content it was read from. The one deliberate exception is target conventions,
  keyed on `structureHash` because they describe layout. Bump `INDEX_VERSION`
  when what an entry holds changes.
- Bump `CONVENTIONS_VERSION` in `src/target-conventions-cache.ts` whenever the
  Target Conventions prompt asks for something new; otherwise an unchanged git
  HEAD keeps serving the old, incomplete answer.
- The Reference Inventory stage exists because read access is not reading: its
  file list is what the later stages work through. If it returns null the run
  continues, but every layer must keep saying so — progress line, stage strip,
  report. Do not let a run with no inventory look like a run with one.
- `--reference` trees are readable but never writable. That is two halves and
  both are load-bearing: `additionalDirectories` opens the read path, and the
  Coding stage's `canUseTool` guard closes the write path. Anything that puts
  `Write`/`Edit` back into that stage's `allowedTools` silently disables the
  guard, because a tool listed there bypasses `canUseTool`.
- The web UI in `src/ui/` is a front end over `bin/aidev.js`, not a second way
  to run the pipeline. It must keep spawning that launcher rather than
  importing `runPipeline` in-process: `src/index.ts` calls `process.chdir`, and
  the launcher is what loads `.env`. Importing it would fork both behaviours.
- The UI server binds to `127.0.0.1` and has no auth, because every endpoint
  can read any path and start an agent that edits any project. Anything that
  widens the bind address, adds a proxy hop, or accepts a remote origin is a
  security-relevant change, not a convenience one.
- The UI is Vietnamese, the rest of the repo is English, and the seam is the
  API: the server sends ids and stable error codes, never display text, and all
  wording lives in `src/ui/public/`. Adding a user-facing sentence to a `.ts`
  file puts it on the wrong side of that line.
- Nothing after the design review is retried. A failed coding task or a failed
  E2E stops the run and reports where; the pipeline does not loop back and
  re-code from the first task. That loop existed and, on a real 8-task run,
  re-spent the whole coding budget and hit the account's usage limit — adding
  a retry back is a cost decision for a person, not a quiet default.
- The design reviewer approves a sound design with `amendments` (exact small
  fixes, appended to the approved design) rather than rejecting it; reject is
  for a design that needs rethinking. Don't tighten this back to approve-only:
  review rounds are capped, and strictness burned all three on one real run.
- A stopped run resumes from `src/checkpoint.ts`: saved after the project
  scan, every rejected design round, the breakdown and every task (clone:
  after the mapping and every group), keyed by
  a fingerprint of the inputs the plan came from. Save progress as each step
  finishes, never only at the end — a killed process never reaches the end.
  A checkpoint must never hold a `--db-connection` value.
- A target is one "app" folder or separate "be"/"fe" folders
  (`src/target-roots.ts`). The first root is the working directory; every
  other root goes into `additionalDirectories` for each stage that reads or
  writes the target. Anything that assumes `projectPath` is the whole project
  (coverage, caches, checkpoints, build checks) must go through the roots.
- Stages that may start the target app (Coding, E2E, Clone Port, Clone
  Build) get free ports from
  `findFreePorts` in the pipeline and the shared `runtimePortsPromptSection`
  rule. Never hardcode or assume a default port in a stage prompt.
- Metadata standards (`src/metadata-standards.ts`) are opt-in per target via
  `.metadata-standards.yml`. Without it no prompt changes — never make them a
  default. Only the enabled modules' guideline sections are sent, located by
  `## §N.` heading: renumbering `docs/metadata-standards-ai-guidelines.md`
  means updating `MODULE_SECTION`/`ALWAYS_SECTIONS` (the tests fail loudly
  otherwise). Clone Port stays faithful to its source under the standards; it
  reports violations, it does not restructure the port.
- `--no-metadata-standards` (`metadataStandardsFor` in `metadata-standards.ts`,
  wired in `index.ts`, exposed as a selectbox in the UI) is a per-run override,
  not a second way to opt in — it forces the result to `null` for one run
  without touching the target's `.metadata-standards.yml`. Keep the override at
  this one call site rather than teaching `loadMetadataStandards` about it, so
  every other caller still sees the file honestly.
  `describeMetadataStandardsOverride` exists only so the progress line can
  distinguish "skipped by request" from "no file to begin with" — do not let
  those collapse into the same log line again.
- The FIS skill catalog (`src/skills-catalog.ts`) is NOT opt-in — unlike
  metadata standards, it needs no per-project decision, so every stage that
  designs, reviews or writes code is always shown it (name + description
  only). A repo with no `~/.claude/skills` and no project `.claude/skills`
  gets an empty catalog, which reads as "not found, skip" — that fallback is
  the point, not a bug. The global directory has to be added to
  `additionalDirectories` (and to `guardReferenceRepos`'s read-only list on
  Coding/Clone Port/Fix) wherever the catalog is used, or the agent can be
  told about a skill it cannot actually `Read`.
- `relevantSkillCatalog` (also in `skills-catalog.ts`) is what actually reaches
  a stage — `loadSkillCatalog`'s full result is an intermediate value, capped
  and ranked by `config.maxSkills` in `index.ts` before it is ever attached to
  `spec`/`clone`. A skill with zero keyword/name/description overlap with the
  task text is dropped, not kept as a low-ranked filler — do not turn that
  into a "top N regardless of score" fallback; an empty result there is
  correct, not a bug to paper over. `totalInstalled` on `SkillCatalog` survives
  filtering on purpose, for the progress line's "X/Y relevant" — keep setting
  it from the pre-filter count, not `entries.length`, in any new call site.
- `src/sdk-helpers.ts` checks `is_error` on the terminal result, not just the
  subtype — a `"success"` subtype can still be an error the SDK didn't throw
  for (rate limit, auth, billing, an outage mid-turn), and that check exists
  because it happened for real, not as a defensive guess. Every stage funnels
  through `runTextQuery`/`runStructuredQuery`, so fix this class of failure
  there once, never per stage.
- `runStructuredQuery` retries exactly one subtype on its own —
  `error_max_structured_output_retries`, capped at `config.maxStructuredOutputRetries`
  — and nothing else, on purpose. Do not widen this to a general is_error retry:
  this repo already removed a blanket retry loop once (the Coding-stage one in
  the history above) after it silently re-spent a whole usage budget re-doing
  finished work. A retry here is cheap only in the sense that it is scoped to
  one subtype known to be transient; it is still a brand-new session that
  re-spends the stage's whole turn budget, so keep the cap small and keep it
  off every other failure kind.
