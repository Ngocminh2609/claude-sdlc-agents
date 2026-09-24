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
- A stopped run resumes from `src/checkpoint.ts`: saved after the breakdown
  and after every task (clone: after the mapping and every group), keyed by
  a fingerprint of the inputs the plan came from. Save progress as each step
  finishes, never only at the end — a killed process never reaches the end.
  A checkpoint must never hold a `--db-connection` value.
- Stages that start the target app (Coding, E2E) get free ports from
  `findFreePorts` in the pipeline and the shared `runtimePortsPromptSection`
  rule. Never hardcode or assume a default port in a stage prompt.
- `src/sdk-helpers.ts` checks `is_error` on the terminal result, not just the
  subtype — a `"success"` subtype can still be an error the SDK didn't throw
  for (rate limit, auth, billing, an outage mid-turn), and that check exists
  because it happened for real, not as a defensive guess. Every stage funnels
  through `runTextQuery`/`runStructuredQuery`, so fix this class of failure
  there once, never per stage.
