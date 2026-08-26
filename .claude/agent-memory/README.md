# Agent memory (not backed up by git)

This directory holds Claude Code subagents' persistent working notes (e.g.
`code-reviewer/MEMORY.md`) — accumulated locally as agents work in this repo.
It's gitignored on purpose: this is scratch/working memory, not source, and
nothing in the pipeline reads it to run.

## MANUAL STEP — moving to a new machine

Nothing here is required to get the project running again (`npm install` +
a re-created `.env` is enough — see `.env.example`). If you want to keep the
accumulated notes anyway, copy the whole `agent-memory/` folder yourself
(zip it, USB, cloud drive — git will not do this for you) and drop it back
in at `.claude/agent-memory/` on the new machine.

If you skip this, agents just start with empty memory and rebuild it over
time — no functional loss, only lost history.
