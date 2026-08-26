# claude-sdlc-agents

Local multi-agent software-engineering pipeline built on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview). You run it against a spec document and a target project directory; it implements the spec and verifies it by actually running the project through a real browser (Playwright), looping back to fix bugs until everything passes.

```
Spec (.md) + optional DB info
        │
        ▼
Orchestrator (review) <──feedback──> Specs & Arch
                                          │ approved
                                          ▼
                                  Task breakdown
                                          │
                                          ▼
                         Coding & Unit Test (per task) ──> E2E/QA (Playwright, real browser)
                                          ▲                        │
                                          └────── feedback ────────┘ fail
                                                                    │ pass
                                                                    ▼
                                                    done — files on disk, git left to you
```

If the Orchestrator never approves a design, or E2E/QA never passes after retrying, the pipeline stops and prints why — it never pretends something is done when it isn't, and it never touches git.

## How it's built

This repo calls the Agent SDK's `query()` directly (see `src/stages/`) rather than using the official `anthropics/claude-code-action` wrapper — that wrapper runs one continuous session responding to `@claude` mentions, and doesn't expose the hard approval gates this pipeline needs between stages.

There is **no GitHub integration** in this version: no issue trigger, no GitHub Actions workflow, no automated commit or push. You invoke it as a local CLI command against any project directory, and you commit the result yourself after reviewing it.

## Prerequisites

- Node.js 18+
- One of:
  - `ANTHROPIC_API_KEY` — pay-per-token, from the [Claude Console](https://platform.claude.com/).
  - `CLAUDE_CODE_OAUTH_TOKEN` — uses a Claude Pro/Max/Team/Enterprise subscription instead. Generate it by running `claude setup-token` in a real interactive terminal (it opens a browser to log into claude.ai, then prints the token). This must be run from a real terminal on your machine — it hangs with no output in a non-interactive shell.

## Usage

```bash
npm install
export ANTHROPIC_API_KEY=your-api-key   # or CLAUDE_CODE_OAUTH_TOKEN

npm run pipeline -- --spec ./specs/my-feature.md --project /path/to/target/project
```

Optional DB flags (pass at most one):
- `--db-connection "postgres://user:pass@host/db"` — an existing database the code should integrate with.
- `--db-schema ./schema.sql` — a schema/description file to design a new DB from.

**Before running**, commit or stash any uncommitted work in the target project — this tool edits files in your working tree directly, with no branch isolation, and does not create a backup.

When it finishes:
- **Success**: the message says E2E/QA passed. Review the diff (`git status` / `git diff` in the target project) and commit yourself.
- **Escalation**: it prints why it stopped (design never approved, or E2E/QA never passed after retrying) and exits non-zero. Code already written stays on disk for you to inspect and finish by hand — nothing is reverted.

Every run — success, escalation, or crash — writes a full log to `runs/<timestamp>-<project>-<spec>/` in **this** repo (not the target project): `log.json` (structured) and `report.md` (every proposal, review decision, task, coding attempt, and E2E verdict with acceptance-criteria evidence). The path is printed at the end. The raw value of `--db-connection` is never written to it (only whether one was provided) — a run log is not a safe place for a real credential. `runs/` is not gitignored on purpose, since it's the audit trail of what the AI actually did; commit it or not, that's your call.

## How the E2E/QA stage works

It does not trust or re-run the Coding stage's own tests. In a fresh session with no memory of the Coding stage, it:
1. Reads `package.json` to find how to start the project.
2. Installs Playwright if the target project doesn't already have it, and sets up a `playwright.config` with a `webServer` block so Playwright starts the app itself and waits for it to be ready.
3. Writes its own Playwright tests under `e2e/`, covering every acceptance criterion in the spec by driving the real user flows through a real (headless) browser.
4. Runs the tests and maps every acceptance criterion to concrete evidence — a criterion with no covering test fails the run, even if everything else passes.

This stage can create/edit only files under `e2e/`, files named `*.spec.ts`/`*.spec.js`, or `playwright.config.*` — enforced by a `canUseTool` callback, not just an instruction — so it can report defects but cannot patch the application to make its own tests pass.

## Tests

```bash
npm test
```

Unit tests cover the pure control-flow logic and every stage's tool-permission configuration, with the Claude Agent SDK calls mocked out — they don't call the real API.

## Known limitations

- Task breakdown assumes tasks are independent enough to implement one after another without conflicting; it runs them sequentially, not in parallel, to avoid file-conflict risk. Revisit if a spec regularly produces many genuinely-parallel tasks and sequential execution becomes a real time cost.
- Structured output (`outputFormat: json_schema`) is validated by the SDK, but a `success` result with no `structured_output` is possible in rare cases. Every stage that relies on structured output treats that case as a failure (fail-closed), not a silent success.
- Retry caps (3 attempts per loop) and per-stage `maxTurns` are starting defaults — tune them once you have real run data.
- **Prompt injection / secret exfiltration risk (residual, not fully closed).** The spec/DB content flows unsanitized into every stage's prompt. The Coding and E2E stages have `Bash`, and the process's environment carries `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN` — if the Bash tool's subprocess inherits that environment (unverified from this repo), a sufficiently crafted injected instruction (e.g. pasted from a compromised page into the spec) could try to exfiltrate them. `curl`/`wget` are explicitly blocked in `disallowedTools` as a first layer, but a disallow-list can't rule out every network-capable interpreter, so this isn't a complete fix.
- If the pipeline throws an unexpected error mid-run (network failure, SDK bug, etc.), it's caught at the top level, logs full detail to the console, and reports a generic "unexpected error" message rather than leaking internal error text — but it does **not** retry; you have to re-run after checking the log.
- No sandboxing beyond the tool-permission restrictions above: the Coding and E2E stages run with real filesystem and network (minus curl/wget) access in your target project. Only point this at projects/directories you're comfortable an AI agent editing directly.
