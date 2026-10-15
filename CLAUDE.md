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
  decision, 2026-09-28) and, since 2026-10-06 (user decision, to cut tokens),
  does not start the app either — it verifies its task by build + formatter +
  linter only, and relies on
  E2E/QA, right after it, to independently prove the whole feature against the
  spec's acceptance criteria through a real browser. This is deliberately
  scoped to feature mode only: clone mode's Clone Tests stage (mocked
  CRUD unit tests) stays as-is, because clone mode does not run E2E at all
  (freshly ported code usually cannot start on its own — see clone mode's own
  "Two honest limits") and would otherwise have no functional check beyond
  "does it compile". Do not remove Clone Tests on the strength of this
  decision; that is a separate call the user has not made.
- That rule lives once in `src/prompts/feature-test-policy.ts` and goes to
  Specs & Arch, task breakdown and Coding alike. Telling only Coding was not
  enough: on a real run the design and every task still asked for unit test
  classes, Coding followed the task, and tests were ~44% of the code written.
  Coding's `guardNewTestFiles` refuses creating a new test file; editing an
  existing one stays allowed so an intentional behaviour change is not stuck.
- Every stage session is isolated by `isolatedOptions` in `src/sdk-helpers.ts`
  (`settingSources: []`, `strictMcpConfig`, `tools` derived from
  `allowedTools` + gated Write/Edit + TaskStop with Bash). Without it each
  session loaded the operator's whole `~/.claude` — hooks, personal CLAUDE.md,
  user MCP servers, skill/agent listings, every built-in tool schema — measured
  at 32.8K tokens of context against 7.7K isolated, re-read on every turn. Do
  not drop it to "inherit the user's setup"; a stage that really needs a tool
  declares it.
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
  when what an entry holds changes. An index is per folder (git scoped to it
  with `--relative`), first builds are saved per `SEGMENT_FILES` and resumed
  from `partial`, and `pruneOverlappingIndexes` (run start only — never from
  the per-task refresh, which sees only the target folders) deletes indexes
  overlapping the run's folders. Stage caches are one file per kind per project
  holding the key's hash. Before each coding task `locateTask` refreshes the
  index and passes `taskLocations` lines to the prompt.
- Specs & Arch may end a proposal with `## Business questions` (business only —
  the prompt tells it to decide technical matters itself). The pipeline stops
  `needs-answers` before review with the draft saved; `--answers` revises it
  once per run without using an attempt. Keep answers out of the fingerprint.
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
- The UI mirrors the two-pipeline split: feature and clone are separate tabs
  with separate forms (`feature-*` / `clone-*` ids, built into `forms` in
  `app.js`), separate presets (`Preset.mode`) and per-flow next-step text
  (`NEXT_STEPS[mode]`). Only the progress/log block is shared, because there
  is one run at a time — it is labelled with the running flow. Don't fold the
  forms back behind one switch with shared fields: that is how a clone preset
  lost its keyword and a clone run was told to "re-run with the same spec".
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
  strictness once burned all three review rounds on one real run.
- Every step runs once per run (user decision, 2026-10-06): one design round
  (`maxSpecAttempts: 1`; a reject stops the run with its feedback saved, and
  the next run revises that proposal), and saved progress is never redone on
  the pipeline's own judgement. A stale, unreadable or wiped-out checkpoint
  stops the run with status `progress-kept`; only `--fresh` discards it. It
  happened: an input outside the spec changed between two runs of the same
  spec, the second silently re-planned and re-coded two finished tasks, and its
  first save overwrote the progress.
- Progress survives the process being killed (machine shut down, UI server
  stopped): only `--fresh` / "Chạy lại từ đầu" discards it. Every agent step
  of both pipelines — scan, design, review, breakdown, each Coding task and
  E2E; clone plan:locate/conventions/mapping, each port group and every
  verify build/tests/fix step — runs through `StepJournal`
  (`src/step-session.ts`): its session id is saved in the checkpoint as
  `activeStep` before the session starts, and the SDK writes the transcript
  as it goes, so the next run resumes that very conversation (`resumePrompt`,
  fresh ports carried over) instead of starting the step over. The id reaches
  the query through AsyncLocalStorage (`claimStepSession` in
  `runQueryLoop`), so stages stay unaware of it; only a step's first query is
  tied to it (a structured-output retry gets its own). When the transcript is
  gone, a Coding task starts a new session told to continue from the files on
  disk. Finished steps are never re-run: their results are in the checkpoint
  (feature: `draft`/`approved`/`completedTasks`; clone: `completedGroups`
  and `verify.results`, which is dropped once a verify pass ends so a re-run
  after an `incomplete` outcome checks the code afresh — same for a finished
  E2E). Any save made before the interrupted step is reached must keep
  `journal.unfinished`, or a second interruption loses the session to resume.
  The CLI's run loggers are built with `saveAsItGoes`, so a killed run still
  leaves its log as `in-progress` in the history. Unit tests must clean up
  only the run folder they wrote (`logger.write()` returns it) — never
  `runs/` itself, which holds every checkpoint and the history.
- The project map (`src/project-memory.ts`, `runs/.project-memory/`, one JSON +
  a readable `.md` per set of target folders) keeps what outlives a run: the
  project conventions, keyed on `manifestHash` from the project index — the
  SET of build manifest/CI file paths, not their content (a new dependency in
  package.json re-spent the scan on nearly every run) and not the content
  version (every run writes code) — and the features earlier runs built, task
  by task. The Project Context agent scan runs only when the map has no
  conventions for the current manifest set; otherwise the saved ones are
  reused (relevant files are then looked up in the index). Specs-arch, task
  breakdown and Coding get the feature list. After each coding task the
  pipeline refreshes the project index (plain code) and records what the task
  really wrote (`changedLines`: `path | kind | tags`) — in the map and in
  `CompletedTask.files`, which later tasks get instead of opening the files.
  Earlier tasks are named by their first line only in a Coding prompt: their
  full descriptions were several thousand characters each, re-sent every turn. Works with or
  without git. Only a run whose `spec.projectMemory` was loaded (the CLI)
  reads or writes it, and a write from vitest without `AIDEV_MEMORY_DIR`
  throws. A failed map write never fails the run (`bestEffort`).
- `refreshRepo` (project index) and the project map both refuse to write from
  vitest unless `AIDEV_INDEX_DIR` / `AIDEV_MEMORY_DIR` point at a temp folder:
  `runs/` holds every checkpoint and the run history, and a test once deleted it.
- Coding gets the project conventions but not the planning-stage relevant-file
  list (it was ~20K characters re-sent on every turn of every task), and its
  prompt carries a token budget: batch independent tool calls in one response,
  read files only with Read and once (Edit requires a Read anyway, so a Bash
  `cat` paid for the same file twice — measured on a real run), look symbols up
  in the project index instead of exploring. Pre-loading the files a task
  edits into the prompt was tried and rejected: the agent Reads them again
  before Edit regardless, so the content would be paid for twice.
- `aidev spec` (`src/stages/spec-draft.ts`, UI mode `"spec"`) drafts a spec
  from a plain-language request and stops at the file. It is read-only
  (`Read`/`Glob`/`Grep`) and must never chain into the feature pipeline by
  itself: a person reviewing and confirming the draft is the whole point of
  the step. In the UI a finished draft only fills step 3 (the spec file). The
  person still reviews it and starts step 5 through the usual commit/stash
  gate. Do not add an "auto-run after drafting" option. That would remove the
  only review between an AI's guess and code written into a working tree.
- Database scripts (`src/database.ts`, `src/database-scripts.ts`,
  `src/sql-safety.ts`): with `--db-connection`, the pipeline itself runs the
  new `.sql` files from the `--project-sql` folder after each coding task.
  Which files run, in what order, and whether one is allowed to run, are
  decided by plain code (content hashes, file names, statement scan), never by
  a model. Keep it that way, for the same reason `checkCoverage` stays
  deterministic. The connection string never reaches a prompt, the
  checkpoint, the run log or a preset: stages get `spec.database`
  (engine, host/db, folder) only. Refusing top-level DROP/TRUNCATE/DELETE is a
  user decision (2026-10-05). Do not relax it into a warning. The pre-run
  baseline is what keeps the pipeline from re-running scripts that were
  already in the folder; never drop it to "run everything new-looking".
- A feature run's E2E verdict is decided by `combineVerdict` (`src/e2e-check.ts`): the agent's pass
  counts only when the pipeline's own Playwright re-run agrees. That means tests exist, none
  failed/flaked/skipped, every one carries the guard's attachment, and the guard saw no API problem.
  Keep it that way: a verdict resting on the agent's word alone is the gap this closes, since a test
  can pass on the screen while the API behind it answered 500. The guard and the wrapper config
  (`src/e2e-guard.ts`) are rewritten right before that re-run, so an edit by the E2E agent cannot
  weaken them. Do not let the agent skip the re-run, and do not make 5xx allowable through
  `apiGuard.allow`.
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
- Stages that may start the target app (E2E, Clone Port, Clone Build — not
  feature Coding, which no longer runs the app) get free ports from
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
- Loop engineering lives in four plain-code pieces, none of which retries:
  the loop guard (`src/loop-guard.ts`: repeat warn/refuse, wrap-up nudge at
  `softCapRatio` of `maxTurns`, Bash output cut to head + tail) attached by
  `isolatedOptions` to every stage with a `maxTurns`; a per-step
  `maxBudgetUsd` (`limitsOf` in `config.ts` — a new stage takes its turn and
  spend caps from there, and a missing budget key fails to compile); the run
  budget (`--max-run-usd`, `src/run-budget.ts`, checked in `StepJournal.run`
  before anything is saved for the step, ends the run `budget-stopped` with
  progress kept); and the feature build check (`src/verify-gate.ts`). The
  check's commands come from a model (Project Context / Target Conventions
  `verifyCommands`), so `refusalOf` decides in plain code whether one may run
  — never widen it to chaining, redirection, installs or writers, and never pass
  the pipeline's credentials to it. A failed check stops the run and keeps the
  task's session as `activeStep` with `gateFailure` in the checkpoint; adding a
  fix-and-recheck loop there is the cost decision the "nothing after the design
  review is retried" rule reserves for a person. `updatedToolOutput` for Bash
  must keep Bash's object shape — a string was verified to be ignored. Keep `GUARD_NOTICE` on guarded stages: without it a real agent ignored the guard's messages as unverified text.
- The UI's mind map is computed in `src/ui/mind-map.ts` from `step` events
  (`src/step-activity.ts`: start/turn/end per `StepJournal` step and
  `gate:<task>`, plus `plan` for tasks and port groups). A running agent
  step's percentage is turns used of its cap, capped at 95 and flagged
  `estimate` — never present it as work done, and only a step's end makes 100.
- `runStructuredQuery` retries exactly one subtype on its own —
  `error_max_structured_output_retries`, capped at `config.maxStructuredOutputRetries`
  — and nothing else, on purpose. Do not widen this to a general is_error retry:
  this repo already removed a blanket retry loop once (the Coding-stage one in
  the history above) after it silently re-spent a whole usage budget re-doing
  finished work. A retry here is cheap only in the sense that it is scoped to
  one subtype known to be transient; it is still a brand-new session that
  re-spends the stage's whole turn budget, so keep the cap small and keep it
  off every other failure kind.
