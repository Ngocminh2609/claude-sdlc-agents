# claude-sdlc-agents

Automated software-engineering pipeline built on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview). A new GitHub issue labeled `ai-auto` triggers four Claude agents in sequence:

```
Orchestrator (review) <──feedback──> Specs & Arch
                                          │ approved
                                          ▼
                                  Coding & Unit Test ──> QA/Tester
                                                              │ pass
                                                              ▼
                                                    branch pushed (no auto-PR)
```

If the Orchestrator never approves a design, or QA never passes, the pipeline stops and posts a comment on the issue explaining what happened, instead of pushing broken or unreviewed code silently.

## How it's built

This repo calls the Agent SDK's `query()` directly (see `src/stages/`), rather than using the official `anthropics/claude-code-action` wrapper — that wrapper runs one continuous session responding to `@claude` mentions, and doesn't expose the hard approval gates this pipeline needs between stages.

## Prerequisites

- Node.js 18+
- An Anthropic API key

## Setup

1. Add an authentication secret (Settings → Secrets and variables → Actions → New repository secret) — one of:
   - `ANTHROPIC_API_KEY`: pay-per-token, from the [Claude Console](https://platform.claude.com/) (needs its own billing setup, separate from a claude.ai subscription).
   - `CLAUDE_CODE_OAUTH_TOKEN`: uses a Claude Pro/Max/Team/Enterprise subscription instead — generate it by running `claude setup-token` in a real interactive terminal (it opens a browser to log into claude.ai, then prints the token). Only one of the two secrets is needed; the workflow passes both through and the SDK uses whichever is present.
2. Confirm Settings → Actions → General → **Workflow permissions** allows read/write (some orgs default to read-only, which overrides the `permissions:` block in the workflow file).
3. Create a label named `ai-auto`.
4. (Recommended) Enable branch protection on `main` (require PR review, disallow force-push). Don't extend the protection pattern to `ai/*`, since the pipeline needs to push those branches freely.
5. (Recommended) Set a spend limit in GitHub Actions billing and in the Anthropic Console, as an account-level backstop against runaway cost.

**You do not need to install the Claude GitHub App.** That app is only required by the `claude-code-action` wrapper and related first-party features (Code Review, web auto-fix). This repo authenticates directly with `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, plus the default `GITHUB_TOKEN`.

## Usage

Label an issue `ai-auto` (or open one already labeled). Watch the Actions run. When it finishes:

- **Success**: a branch `ai/issue-<number>-<slug>` is pushed. Review it and open the PR yourself.
- **Escalation**: a comment is posted on the issue explaining what blocked the pipeline (design never approved, or QA never passed). A QA escalation still pushes the work-in-progress branch for inspection.

## Local dry-run

Before relying on real GitHub issues, exercise the same code path locally:

```bash
npm install
export ANTHROPIC_API_KEY=your-api-key
npm run pipeline -- --issue-file ./fixtures/sample-issue.json --dry-run
```

`--dry-run` swaps in a GitHub adapter that logs comments to stdout instead of calling the GitHub API, and skips the real `git push` (see `src/github/`).

## Tests

```bash
npm test
```

Unit tests cover the pure control-flow logic (`src/pipeline.ts`, `src/git.ts`) with the Claude Agent SDK calls mocked out — they don't call the real API.

## Known limitations

- GitHub does not trigger other workflows on commits pushed with the default `GITHUB_TOKEN`. If you later add a CI-on-push workflow, it won't fire on the AI-pushed branch unless you switch to a PAT or GitHub App token. Acceptable for now since the pipeline already runs tests inline before pushing.
- The QA stage has `Bash` but not `Write`/`Edit`; it can still write files via shell redirection. The pipeline only commits the diff produced by the Coding stage, before QA runs, so QA-stage side effects are never part of the pushed commit.
- Structured output (`outputFormat: json_schema`) is validated by the SDK, but a `success` result with no `structured_output` is possible in rare cases. Every stage that relies on structured output treats that case as a failure (fail-closed), not a silent success.
- Retry caps (3 attempts per loop) and per-stage `maxTurns` are starting defaults — tune them once you have real run data.
- **Prompt injection / secret exfiltration risk (residual, not fully closed).** The issue title/body flow unsanitized into every stage's prompt. The Coding and QA stages have `Bash`, and the pipeline process's environment carries `ANTHROPIC_API_KEY`/`GITHUB_TOKEN` — if the Bash tool's subprocess inherits that environment (unverified from this repo), a sufficiently crafted injected instruction could try to exfiltrate them. `curl`/`wget` are explicitly blocked in `disallowedTools` as a first layer, but a disallow-list can't rule out every network-capable interpreter, so this isn't a complete fix. Mitigating factor: the repo is private, so only invited collaborators can open issues at all — this meaningfully narrows the threat model but doesn't eliminate a collaborator accidentally pasting injected text (e.g. copied from a compromised page). Revisit if the repo ever goes public, or if the SDK exposes a way to restrict the Bash tool's inherited environment.
- If the pipeline throws an unexpected error mid-run (network failure, SDK bug, etc.), it's caught at the top level, logs full detail to the workflow run log, and posts a generic "unexpected error" comment on the issue rather than leaking internal error text — but it does **not** retry; a human has to re-trigger (re-label) after checking the log.
