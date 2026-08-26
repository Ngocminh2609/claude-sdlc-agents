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
