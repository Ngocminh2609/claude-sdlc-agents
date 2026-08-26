# Pipeline run output (not backed up by git)

Each `npm run pipeline` invocation writes a `<runId>/log.json` and
`<runId>/report.md` here (see `src/run-log.ts`) — the full transcript of
that run: proposals, review decisions, tasks, coding attempts, E2E
verdicts. It never contains secrets (`RunLogger` explicitly drops the raw
`dbInfo` value before writing). This content is gitignored — it's local run
history, not source, and can grow large over many runs.

## MANUAL STEP — moving to a new machine

Nothing here is required to get the project running again. If you want to
keep past run history, copy this folder yourself (git will not do this for
you) before switching machines — same as `.claude/agent-memory/`.
