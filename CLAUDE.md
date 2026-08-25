# Project conventions

- TypeScript, ESM (`NodeNext`), strict mode. No CommonJS.
- Each pipeline stage in `src/stages/` is a small, independent function — do not
  add a generic `runStage()` abstraction unless real duplication justifies it.
- Git mutations (branch/commit/push) happen only in `src/git.ts`, called from
  `src/pipeline.ts` after the QA gate — never delegate them to an agent's own
  tool calls.
- Any change to a stage's `allowedTools`/`disallowedTools` is a security-relevant
  change: re-check it against the separation-of-duties intent (QA cannot edit
  files; Coding cannot run git-mutating commands) before merging.
