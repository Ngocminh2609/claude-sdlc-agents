# ADR: Pivot from GitHub-issue-triggered CI to a local, spec-driven, browser-tested CLI tool

**Date:** 2026-08-26
**Status:** Accepted
**Supersedes (in part):** `20260825-agent-sdk-pipeline-architecture.md` — the SDK-direct-vs-wrapper decision there still stands; this ADR replaces the trigger mechanism, the input format, the QA methodology, and removes all git automation.

## Context

The original design (previous ADR) was triggered by a labeled GitHub issue on a CI runner, and finished by pushing a branch. In practice, the intended usage changed: the user wants a tool they run locally against an existing project, driven by a spec document instead of an issue, that verifies its own work by actually running the app through a real browser rather than only unit tests, and that never touches git — commits stay a manual, human step.

## Decision

Remove the GitHub Actions workflow, the `git.ts` branch/commit/push code, and the `github/` comment-posting adapters. Replace the trigger with a local CLI invocation (`--spec <path.md> --project <path>`), replace the QA stage's unit-test-only verification with an independent Playwright-driven E2E stage, and add a task-breakdown step so the Orchestrator can hand discrete pieces of an approved design to the Coding stage one at a time.

## Options Considered

| Option | Pros | Cons |
|--------|------|------|
| **Local CLI, no git, Playwright E2E** (chosen) | Matches the actual desired workflow; removes an entire class of CI/secrets/webhook concerns; E2E against a real running app catches what unit tests can't | Loses the audit trail a GitHub issue/PR gave for free; no branch isolation, so a bad run leaves the working tree dirty until the user notices |
| Keep GitHub trigger, just change what happens inside the job | Less code churn | Doesn't match the requirement at all — the user explicitly wants no GitHub interaction and no automated git operations |
| Keep git automation but make it optional via a flag | Preserves both workflows | Speculative — no current need for the old mode; adds a maintenance burden (two tested code paths) for a capability nobody asked to keep. Rejected per YAGNI; can be re-added from git history if ever needed. |

## Consequences

- **Positive:** the tool works against any existing local project, not just this repo, and doesn't require any GitHub setup (secrets, labels, workflow permissions) at all anymore.
- **Positive:** E2E/QA now verifies the acceptance criteria by actually driving the app, not by trusting that unit tests the Coding stage wrote are honest or sufficient — matches the AC-traceability practice already established, but on real user flows instead of unit-level checks.
- **Negative / trade-off:** no branch isolation. A run leaves whatever it wrote directly in the working tree; the README now explicitly tells the user to commit/stash before running. There is no automated backup or rollback.
- **Negative / trade-off:** the E2E stage needs `Write`/`Edit` for test files (Playwright specs, `playwright.config`), which the old QA stage never needed. Scoped via a `canUseTool` callback restricted to `e2e/`, `*.spec.ts`/`*.spec.js`, and `playwright.config.*` — verified against the SDK's actual shipped type definitions (`(toolName, input, options) => Promise<PermissionResult | null>`), which differ from the `(request, response)`-callback shape shown in the public docs at the time this was written. Trust the installed `.d.ts` over the docs when they disagree.
- **Risk accepted:** task breakdown runs sequentially, not in parallel, even though the user described the Orchestrator "distributing tasks to APIs" in a way that could imply concurrency. Sequential avoids file-conflict risk for a first version; revisit only if this proves to be a real bottleneck.
