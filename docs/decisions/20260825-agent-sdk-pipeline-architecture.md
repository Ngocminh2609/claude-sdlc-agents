# ADR: Multi-agent SDLC pipeline built on the Claude Agent SDK directly

**Date:** 2026-08-25
**Status:** Accepted

## Context

We need an automated pipeline that turns a labeled GitHub issue into a reviewed,
pushed branch through four roles (Orchestrator, Specs & Arch, Coding & Unit
Test, QA/Tester), with a real feedback loop between the Orchestrator and
Specs & Arch, and an independent QA pass that can't just rubber-stamp the
Coding stage's own work. It has to run unattended in CI (GitHub Actions), so
the design needs to be no-human-in-the-loop by default, with escalation
(not silent failure or silent bad output) when the roles can't agree.

## Decision

Call the Claude Agent SDK's `query()` directly from a custom Node/TypeScript
script, with our own control-flow code driving the four stages — not the
official `anthropics/claude-code-action` GitHub Action, and not an extension
of the existing FIS AI Kit skills (`fis-outcome`/`fis-craft`/`fis-test`).

## Options Considered

| Option | Pros | Cons |
|--------|------|------|
| **Claude Agent SDK, direct `query()` calls** (chosen) | Full control over hard gates between stages; each stage gets its own `allowedTools`/`permissionMode`/`outputFormat`; officially documented as the path for "custom automation outside GitHub Actions" | Have to build session/state handling, git operations, and GitHub comments ourselves |
| `anthropics/claude-code-action` wrapper | Zero-code setup; battle-tested; handles GitHub App auth | Runs as one continuous Claude Code session reacting to a prompt/mention — no way to declaratively insert a hard approve/reject gate between an "architect" pass and a "coder" pass; it's built on the SDK, so it's a ceiling on control, not a different capability |
| Extend FIS AI Kit (`fis-outcome` → `fis-craft` → `fis-test`) | Reuses an already-installed, working skill set | It's a single-session, sequential *router*, not independent agents with a real approve/reject loop; no separate QA-vs-Coding adversarial split; not triggerable from a bare GitHub issue event today |

## Consequences

- **Positive:** every stage boundary is an explicit, auditable gate in our own code, not something implicit inside one long agent session. New stages or different retry policy just require touching one script.
- **Positive:** confirmed via the SDK's own docs that `permissionMode: 'default'` combined with an explicit `allowedTools` list denies anything uncovered with no callback needed — no need for `bypassPermissions`, which would have been a bigger blast-radius default for an unattended CI job.
- **Negative / trade-off:** we own git branch/commit/push and GitHub comment code ourselves (in `src/git.ts` and `src/github/`) instead of getting it for free from the wrapper action's GitHub App integration.
- **Negative / trade-off:** no session resume between retries — each retry (Specs & Arch↔Orchestrator, Coding↔QA) is a fresh `query()` call with the prior artifact and feedback concatenated into the prompt, not a continued conversation. Chosen deliberately: it keeps each call a pure function of (artifact + feedback), avoids threading session IDs across an ephemeral GitHub Actions runner, and matches the "3-attempt cap then escalate to a human" failure-loop pattern already proven in FIS AI Kit's `fis-outcome` skill.
- **Risk accepted:** GitHub does not trigger further workflows on commits pushed with the default `GITHUB_TOKEN`. Acceptable for now since QA already runs the test suite inline before the branch is pushed; revisit if a CI-on-push workflow is added later.

## Related implementation decisions (consequences of the above, not separately deliberated)

- Git branch/commit/push is executed by our own TypeScript code (`src/git.ts`), never delegated to the Coding agent's own `Bash` tool calls — the one step that must be deterministic and only happen after the QA gate passes.
- The QA stage runs as a brand-new session with no memory of the Coding stage, and is denied `Write`/`Edit`, so it can report but not "fix" — genuine separation of duties, not the Coding agent grading its own work.
- QA is required to map every acceptance criterion to concrete covering evidence (test name or reproduction step); an uncovered criterion fails the run even if the test suite otherwise passes — adapted from FIS AI Kit's `fis-outcome` AC↔test traceability requirement.
