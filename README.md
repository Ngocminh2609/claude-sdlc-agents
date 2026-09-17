# claude-sdlc-agents

Local multi-agent software-engineering pipeline built on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview). You run it against a spec document and a target project directory; it implements the spec and verifies it by actually running the project through a real browser (Playwright), looping back to fix bugs until everything passes.

```
Spec (.md) + optional DB info + optional reference repo(s)
        │
        ▼
Reference inventory (only when a reference repo is given)
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

Prompt text shared by more than one stage lives in `src/prompts/`. `code-quality.ts` holds the clean-code, DRY and formatting rules, and both the Specs & Arch and Coding stages append it to their system prompt — so the design plans for reuse and the implementation writes clean code the first time, instead of leaving a cleanup pass for afterwards. Project-specific conventions (naming, layering, framework idioms) belong in your spec document, not in that file: it ships with the pipeline and runs against every target repo.

Formatting follows the same logic and is handled the same way: rather than naming an indent width the rules cannot know, they tell the agent to find the target repo's own setup (`.editorconfig`, Prettier/Biome/Spotless/Checkstyle/gofmt/black/ktlint config, a lint script), obey it, and run it over the files it changed. They also forbid reformatting code the task did not otherwise touch, and forbid running a formatter across the whole repo — a diff that mixes real changes with whitespace churn is one nobody can review.

## Prerequisites

- Node.js 20.12+ (the `aidev` launcher reads `.env` via `process.loadEnvFile`, added in 20.12)
- One of:
  - `ANTHROPIC_API_KEY` — pay-per-token, from the [Claude Console](https://platform.claude.com/).
  - `CLAUDE_CODE_OAUTH_TOKEN` — uses a Claude Pro/Max/Team/Enterprise subscription instead. Generate it by running `claude setup-token` in a real interactive terminal (it opens a browser to log into claude.ai, then prints the token). This must be run from a real terminal on your machine — it hangs with no output in a non-interactive shell.

## Install

One-time setup, run once per machine from this repo:

```bash
npm install
npm link                      # installs the global `aidev` command
cp .env.example .env          # then fill in ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN
```

`npm link` puts an `aidev` shim in your npm global bin directory, so the command
works from any shell and any directory. It runs `src/` through tsx rather than a
compiled `dist/`, so edits to the source take effect immediately with no build step.

The launcher loads this repo's `.env` itself, using the repo path resolved from the
launcher's own location — not the caller's working directory. That is what makes the
command usable from outside the repo: nothing reads `.env` from wherever you happen
to be standing. Environment variables already exported in your shell still win, since
`process.loadEnvFile` does not overwrite them.

## Usage

```bash
aidev --spec ./specs/my-feature.md --project /path/to/target/project
```

Both paths may be relative — they resolve against your current directory, not the repo.

Inside this repo you can skip the global command and use the npm script instead;
it takes the same flags but does **not** load `.env`, so export the key yourself:

```bash
export ANTHROPIC_API_KEY=your-api-key   # or CLAUDE_CODE_OAUTH_TOKEN
npm run pipeline -- --spec ./specs/my-feature.md --project /path/to/target/project
```

To remove the global command later: `npm unlink -g claude-sdlc-agents`.

Optional DB flags (pass at most one):
- `--db-connection "postgres://user:pass@host/db"` — an existing database the code should integrate with.
- `--db-schema ./schema.sql` — a schema/description file to design a new DB from.

Optional reference flag (repeatable):
- `--reference /path/to/sample-project` — a source tree the agents may **read** to copy
  patterns from, for "build this screen the way the sample project does it".

## Cloning from a sample project

Without `--reference`, every stage can see exactly one directory: the target project.
The pipeline chdirs into it and the Agent SDK scopes file access to the working
directory, so a sample repo sitting elsewhere on disk is invisible — an agent told to
"copy the screen from project A" would find nothing and quietly improvise.

`--reference` passes that directory to the SDK's `additionalDirectories`, and the
Specs & Arch, Task breakdown and Coding stages get read access to it. The E2E/QA
stage deliberately does not: it judges against the spec's acceptance criteria, so
widening its access would add risk and no verification power.

**Access is not attention, so a stage runs first that does nothing but look.** When
a reference is given, the Reference Inventory stage walks the tree once and returns
an explicit list of the files the work should copy from, each with the role it plays.
Every later stage receives that list as a checklist. Without it each session would
rediscover the tree on its own turn budget — and on a real repo (node_modules, Maven
`target/`) that budget goes on walking directories rather than on the work. The list
is written into `report.md` before the design section, so after the run you can diff
what the pipeline set out to copy against what `git diff --stat` says it produced.

If the scan fails, the run continues without a list and says so — in the progress
line, in the stage strip, and in the report. A degraded run is reported as degraded
rather than quietly passing for a thorough one.

This raises the odds of full coverage. It does not make coverage a guarantee: an
inventory can still miss a file, the model chooses what to read, and only what the
spec's acceptance criteria describe is ever verified by E2E.

Reference trees are read-only, and that is enforced rather than requested: the Coding
stage keeps `Write`/`Edit` out of `allowedTools` and gates them through `canUseTool`,
which denies any path resolving inside a reference directory (`path.relative`, so
neither a `sample-evil` sibling nor a `..` traversal gets through). The residual gap
is stated plainly in Known limitations below.

Point the spec at what to look at — access is not attention:

```bash
aidev --spec ./specs/units-screen.md \
      --project "D:/Source_Code/FIS/CSDL-VIMO" \
      --reference "D:/Source_Code/FIS/TKDT"
```

```markdown
## Bối cảnh
Clone the "Danh mục đơn vị tính" screen from the reference project
(src/main/java/.../units, src/app/units). Keep this project's own naming and layering.
```

**Before running**, commit or stash any uncommitted work in the target project — this tool edits files in your working tree directly, with no branch isolation, and does not create a backup.

When it finishes:
- **Success**: the message says E2E/QA passed. Review the diff (`git status` / `git diff` in the target project) and commit yourself.
- **Escalation**: it prints why it stopped (design never approved, or E2E/QA never passed after retrying) and exits non-zero. Code already written stays on disk for you to inspect and finish by hand — nothing is reverted.

Every run — success, escalation, or crash — writes a full log to `runs/<timestamp>-<project>-<spec>/` in **this** repo (not the target project): `log.json` (structured) and `report.md` (every proposal, review decision, task, coding attempt, and E2E verdict with acceptance-criteria evidence). The path is printed at the end. The raw value of `--db-connection` is never written to it (only whether one was provided) — a run log is not a safe place for a real credential. `runs/` is not gitignored on purpose, since it's the audit trail of what the AI actually did; commit it or not, that's your call.

## Web UI

Same pipeline, driven from a browser instead of a terminal:

```bash
aidev ui                 # http://127.0.0.1:4319, opens your browser
aidev ui --port 5000 --no-open
```

On Windows, double-clicking `aidev-ui.cmd` in this repo does the same thing. The
console window it opens *is* the server — close it to stop the UI.

The interface is in **Vietnamese** — the people running it are. The rest of the
repo stays English, and the boundary is enforced rather than assumed: the server
sends ids and error codes (`spec-not-found`, `busy`, …), never display text, and
every user-facing string lives in `src/ui/public/app.js` and `index.html`.

What it gives you over the command line:

- **Run form** — pick the target project, the spec and an optional reference repo
  with a file browser instead of retyping absolute paths, choose a DB option, and
  start the run.
- **Live stage view** — which stage is running, the current attempt,
  and every line the pipeline prints, streamed as it happens.
- **Stop** — kills the pipeline *and* everything it started (tsx, a dev server the
  E2E stage launched, Playwright browsers), so nothing is left holding a port.
  Files already written to the target project are not reverted, same as a Ctrl-C.
- **Spec editor** — write or edit the spec `.md` in the browser and run it without
  leaving the page.
- **History** — every folder under `runs/` with its `report.md` rendered, including
  runs started from the command line.
- **Presets** — save a project + spec combination you run often.
- **Built-in guide** — a "Hướng dẫn" tab covering what each stage does, how to write
  a spec the E2E stage can actually verify, what each stop reason means and what to
  do next, plus the safety boundaries. The run form is a numbered four-step flow,
  and Run stays disabled until you confirm the target project is committed or
  stashed — the pipeline overwrites a working tree with no backup, so that one
  piece of friction is deliberate.

Two things it deliberately does not do. It never stores a `--db-connection` value:
that string can carry a database password, so it is typed per run, kept in memory
only, and masked if it ever appears in the output. And it runs one pipeline at a
time — the pipeline edits a working tree directly with no branch isolation, so a
second concurrent run is refused rather than queued.

It binds to `127.0.0.1` only and has no authentication, by design: every endpoint
can read any path on the machine and start an agent that edits any project on it.
That is the same authority the `aidev` command already has as you, which holds
exactly as long as nothing else can reach the port. Do not put it behind a tunnel
or a reverse proxy.

Under the hood the UI shells out to `bin/aidev.js` per run — the same launcher,
the same `.env` loading, one launch path rather than two. It asks that run for
machine-readable progress by setting `AIDEV_EVENT_STREAM=1` (see `src/events.ts`);
without that variable the CLI prints exactly what it always has.

`npm run ui` works too, but like `npm run pipeline` it does not load `.env`, so the
credential indicator in the header will read "no credential" even though runs
themselves still pick one up from the launcher.

## Clone mode

Porting an existing feature out of another repo is a different job from building
a new one, so it is a different command — not a flag on the same pipeline:

```bash
aidev clone --what "Danh mục nghề nghiệp" \
            --from "D:/Source_Code/FIS/TKDT" \
            --project "D:/Source_Code/FIS/CSDL-VIMO"
```

No spec document. `--from` is repeatable, and pointing it at the module that holds
the feature rather than the repo root is faster and more accurate. `--no-build`
skips the final compile check.

Why a separate pipeline. Feature work asks *what should we build* and answers it
with a design somebody has to approve. A port already has the answer — the source
code is the specification. What it has to decide instead is **placement**, and what
it has to prove is **coverage**. So the design/review loop is gone and two other
things take its place:

```
"Danh mục nghề nghiệp" + reference repo + target project
   │
   1. Locate      — everything in the reference that implements it: SQL, server, client
   2. Conventions — read the TARGET: module layout, package root, FE and SQL conventions
   3. Mapping     — each source file -> target path + the package/import renames it needs
   4. Port        — group by group, sequentially, every group following one mapping
   5. Coverage    — plain code, no model: does every mapped file exist on disk?
   6. Build       — compile what was touched, and quote the real errors if not
```

The mapping is the artifact worth reading. It is a table where a wrong row is
obvious, unlike a design proposal, and the coverage check measures the delivered
files against it. Both go into `report.md`, with a `[x]`/`[ ]` per row, so the
report is the thing you diff against `git diff --stat`.

It does not stop for approval — the mapping appears in the progress stream as soon
as it is decided, and Stop is there if it looks wrong. Two honest limits:

- **Coverage catches a missing file, not a wrongly-placed one.** A controller put in
  a plausible-but-wrong module still compiles and still counts as covered. That is
  why the mapping is shown rather than buried in the log.
- **E2E is not run.** Freshly ported code usually cannot run yet — no rows, no
  config, no wiring — so a browser test would fail runs whose port was correct and
  complete. The build check is the strongest honest signal at that point, and a run
  that could not be verified reports `incomplete`, never `done`.

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
- Each Coding call is a fresh session, so the only things holding a multi-task feature together are what the pipeline hands it: the spec, the approved design, and one-line summaries of the tasks already finished in this pass (each capped, so a long report can't crowd out the actual task). That plus the shared working tree — a later task can read what an earlier one wrote. It is not a shared context: if the front end and the API must agree on a name, put that name in the spec rather than hoping two sessions converge on it.
- **A reference tree is read-only against `Write`/`Edit`, not against `Bash`.** The Coding stage has a shell, and no permission callback can honestly claim to parse arbitrary shell for writes. The prompt forbids modifying a reference repo and the direct file-writing path is blocked; commit anything you point `--reference` at before a run.
- Structured output (`outputFormat: json_schema`) is validated by the SDK, but a `success` result with no `structured_output` is possible in rare cases. Every stage that relies on structured output treats that case as a failure (fail-closed), not a silent success.
- The account hitting its plan usage limit, an auth problem, a billing error, or an outage mid-turn does not make the SDK throw. Per its own types, the affected assistant message carries `error` (e.g. `rate_limit`), and the terminal `result` message can still carry `subtype: "success"` while `is_error` is `true` — a success shape whose text is that notice, not real output. `src/sdk-helpers.ts` checks `is_error` on every result rather than trusting the subtype alone; this was found by hitting it for real, not by reading the docs — a run's own usage limit was hit mid-pipeline, and the Coding stage's "summary" became the literal limit notice, accepted before this check existed.
- Retry caps (3 attempts per loop) and per-stage `maxTurns` are starting defaults — tune them once you have real run data.
- **Prompt injection / secret exfiltration risk (residual, not fully closed).** The spec/DB content flows unsanitized into every stage's prompt. The Coding and E2E stages have `Bash`, and the process's environment carries `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN` — if the Bash tool's subprocess inherits that environment (unverified from this repo), a sufficiently crafted injected instruction (e.g. pasted from a compromised page into the spec) could try to exfiltrate them. `curl`/`wget` are explicitly blocked in `disallowedTools` as a first layer, but a disallow-list can't rule out every network-capable interpreter, so this isn't a complete fix.
- If the pipeline throws an unexpected error mid-run (network failure, SDK bug, etc.), it's caught at the top level, logs full detail to the console, and reports a generic "unexpected error" message rather than leaking internal error text — but it does **not** retry; you have to re-run after checking the log.
- No sandboxing beyond the tool-permission restrictions above: the Coding and E2E stages run with real filesystem and network (minus curl/wget) access in your target project. Only point this at projects/directories you're comfortable an AI agent editing directly.
