# claude-sdlc-agents (`aidev`)

Local multi-agent pipeline on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview). Three jobs:

| Command | Does | Ends with |
|---|---|---|
| `aidev --spec spec.md --project <dir>` | Builds a **new** feature from a spec | E2E in a real browser (Playwright) |
| `aidev clone --what "<keyword>" --from <repo> --project <dir>` | Ports an **existing** feature from another repo | Coverage, wiring, build and unit-test checks |
| `aidev sql-optimize --file <file-or-folder>` | Optimizes SQL for performance, logic unchanged | `<name>_optimized.sql` next to the original |

A failure stops the run and says where and why. Nothing is retried on its own, nothing touches git: review the diff and commit yourself. Every agent step runs once and saves progress, so running the same thing again resumes where it stopped.

## Install

Node.js 20.12+ and one credential: `ANTHROPIC_API_KEY` (pay per token) or `CLAUDE_CODE_OAUTH_TOKEN` (subscription, from `claude setup-token` in a real terminal).

```bash
npm install
npm link                 # global `aidev` command, runs src/ through tsx (no build step)
cp .env.example .env     # add the credential; the launcher loads this repo's .env from anywhere
aidev ui                 # web UI at http://127.0.0.1:4319 (Windows: aidev-ui.cmd)
```

`npm test` runs the unit tests (SDK calls mocked). Remove the command with `npm unlink -g claude-sdlc-agents`.

**Models:** each stage has a tier (`MODEL_TIER` in `src/config.ts`).
- Strong (`claude-opus-5-5`): spec draft, Specs & Arch, design review, clone mapping, SQL check.
- Standard (`claude-sonnet-5-5`): everything else — project scan, task breakdown, Coding, E2E, clone port/build/tests/fix, SQL propose.
- Change a tier with `AIDEV_MODEL_STRONG` / `AIDEV_MODEL_STANDARD`. `CLAUDE_MODEL` forces one model on every stage except the SQL check (`AIDEV_SQL_CHECK_MODEL`).

## New feature

```bash
aidev --spec ./specs/x.md --project-be D:/app/BE --project-fe D:/app/FE [--project-sql D:/app/SQL]
```

**Stages:** project scan → Specs & Arch → design review → task breakdown → Coding (task by task, with a build check after each) → E2E.

- **Spec:** sections *Bối cảnh*, *Yêu cầu*, *Ràng buộc*, *Tiêu chí nghiệm thu*. Every criterion must be checkable in a browser, because E2E grades against them.
  - No spec yet: `aidev spec --request "…" --project-be … --out spec.md` drafts one (read-only). Review it, then run it.
- **Target folders:** `--project`, or `--project-be` / `--project-fe` (the same folder in both counts as one).
- **Database (optional):**
  - `--db-connection "<url|jdbc|ado>"` with `--project-sql`: new scripts in the SQL folder run after each task, each in its own transaction. PostgreSQL, SQL Server and MySQL are supported.
  - Scripts that were already there, files named `*rollback*`, and top-level `DROP`/`TRUNCATE`/`DELETE` never run.
  - The connection is checked before anything is spent, and it is never logged.
  - `--db-schema <file>` instead: design from a schema description, nothing is run.
- **Reference repos (optional):** `--reference <dir>` (repeatable) lets the agents read a sample project for patterns. It is read-only for Write/Edit, but not for Bash, so commit it first. To port a whole feature, use `clone`.
- **Design review:** approve, approve with exact amendments, or reject. One round per run; a rejected design is revised on the next run.
- **Business questions:** decisions the spec leaves open stop the run as `needs-answers`. Answer with `--answers "…"` (UI: *Trả lời câu hỏi nghiệp vụ*) and rerun; the saved design is revised, nothing is redone.
- **Build check:** after each task the pipeline runs the project's own compile/type-check/lint commands (read from CI and build files), judged by exit code.
  - The commands must pass a plain-code allowlist (check-only, no chaining) before they run.
  - A project already failing them has the check turned off for that run.
  - A failure stops the run. `AIDEV_BUILD_FIX_ROUNDS` (0–3, default 0) allows that many fix rounds.
- **E2E:** the agent writes Playwright tests under `e2e/` and may not edit app code.
  - The pipeline re-runs the tests itself, through an API guard (`e2e/aidev-guard.ts`).
  - Pass needs every test run and passing, and no 5xx, network error, undeclared 4xx or page error.
  - Traces, screenshots and video are kept in `runs/<run>/e2e-evidence/`.

## Clone a feature

```bash
aidev clone --what "nghề nghiệp" --from-be D:/sample/BE --from-fe D:/sample/FE --project-be D:/app/BE --project-fe D:/app/FE
```

**Stages:** locate → target conventions → mapping (source file → target path) → port (DB → BE → FE) → coverage and FE↔BE wiring (plain code) → build → unit tests (up to 2 fix rounds).

- `--what` is a loose keyword; spelling variants are generated for the search.
- `--no-build` / `--no-tests` skip those checks.
- Read the **mapping** in the report: coverage catches a missing file, not a misplaced one.
- No E2E: freshly ported code usually can't run yet, so an unverifiable run reports `incomplete`, never `done`.

## SQL optimize

```bash
aidev sql-optimize --file ./SQL/usp_X.sql            # a file, or a folder of .sql files
    [--plan x.sqlplan] [--schema ddl.sql] [--dialect auto|sqlserver|mysql|postgresql]
    [--verify-db "<TEST db>" --test-call "EXEC dbo.usp_X @Year = 2024"]...
    [--instructions "<a logic change you want>"] [--max-run-usd 5] [--overwrite]
```

Per file: **read the execution plan → read the SQL → optimize → write `<name>_optimized.sql`.** The original is never written.

- **Steps, not a rewrite:** the model proposes steps, each with the query it touches, the exact code before → after, why it's faster, why results stay the same, and the plan hotspot it addresses.
  - An independent model check (`AIDEV_SQL_CHECK_MODEL`, default `claude-opus-5-5`) must confirm each step keeps results identical.
  - A plain-code guard also rejects any step that drops a table, column or string literal.
  - Plain code applies the confirmed steps all-or-nothing. Code outside an applied step stays byte-for-byte.
- **Business logic is never changed** unless `--instructions` asks for a specific change.
- **Plan** (`.sqlplan`, PostgreSQL `EXPLAIN (ANALYZE, FORMAT JSON)`, MySQL JSON or text): plain code reduces it to hotspots (cost, full scans, misestimates, implicit conversions, missing indexes). A folder of plans is matched to SQL files by name.
- **Test database** (SQL Server/PostgreSQL; never production):
  - The original runs first, then the code with each step added, each inside a transaction that is always rolled back.
  - A step is kept only if every test call returns exactly the original's results and it isn't more than 20% slower.
  - The real schema (columns, NULL rules, indexes) is read from the catalog, or from `--schema`.
- **Long files:** no fixed length limit. Large files are split at procedure and batch boundaries, each part handled on its own, then reassembled into one output file.
  - The log states the number of parts and AI calls up front.
  - `--max-run-usd` stops before the next part; parts not reached stay unchanged.
  - Optional hard cap: `AIDEV_SQL_MAX_CHARS`.
- **Output header:** lists every step (applied or not, with the reason), warnings and suggested indexes. Index suggestions are comments only, never run.

## Web UI

`aidev ui` serves a Vietnamese UI for all three jobs, plus run history and a built-in guide (*Hướng dẫn*).

- Each tab (*Làm task mới*, *Clone*, *Tối ưu SQL*) has its own run, log, progress mind map (% per step) and Stop button.
- SQL runs alongside anything. Task mới and Clone write into project folders, so only one of the two runs at a time.
- It binds to `127.0.0.1` only and has no login. It refuses cross-site and DNS-rebinding requests. **Never expose it through a tunnel or proxy.**

## How it keeps cost and drift down

- **Project index** (`runs/.project-index/`, plain code, no tokens): one line per file (kind, class, routes, tables, UI strings), refreshed from git.
  - Before each coding task, git changes are re-indexed and the task's files are looked up and put into the prompt.
  - One index per folder; `node_modules` and build output are never indexed.
  - A large first build is saved in segments.
- **Project map** (`runs/.project-memory/`): conventions and per-spec task log, reused until a build file is added or removed.
- **Loop guard** on every agent step:
  - the same call with the same result: warned at 3, refused at 5;
  - a wrap-up nudge at 80% of the turn cap;
  - long Bash output cut to its head and tail.
- **Spend caps:**
  - per step (`config.maxBudgetUsd`);
  - per run (`--max-run-usd`, UI *Ngân sách tối đa*): stops as `budget-stopped` with progress kept.
- **Resume:**
  - checkpoints in `runs/.checkpoint-*` (never with credentials); interrupted agent sessions resume with their conversation;
  - a changed spec, folders, DB option, references, metadata standards or skills stops as `progress-kept`;
  - `--fresh` (UI *Chạy lại từ đầu*) discards saved progress.
- **Ports:** each Coding and E2E session gets free ports picked just before it starts, never the defaults.

## Optional context

- **Metadata standards (NSO-SMR):** a `.metadata-standards.yml` at the target root adds the listed modules of [`docs/metadata-standards-ai-guidelines.md`](docs/metadata-standards-ai-guidelines.md) to the design, review, coding and port prompts. `--no-metadata-standards` skips it for one run.
- **FIS skills:** installed skills (`~/.claude/skills` plus the target's `.claude/skills`) are ranked by keyword overlap with the task. Up to `config.maxSkills` (6) are listed to each stage, name and description only.

## Run records

Every run writes `runs/<timestamp>-…/log.json` and `report.md`:
- feature runs: designs, reviews, tasks, build checks and loop-guard interventions, E2E evidence;
- clone runs: the mapping with ✓/✗ per row;
- SQL runs: every step's before/after.

The UI adds `usage.json` (tokens and estimated cost per stage). Database connection strings are never written.

## Known limitations

- Coding tasks run one after another in fresh sessions, connected only by the spec, the design, earlier task summaries and the shared working tree. Put names the front end and back end must share into the spec.
- Agents with Bash can still write anywhere a shell can, including a reference repo, and could in theory be steered by text injected into a spec. `curl`/`wget` are blocked, but that is not a full sandbox. Point it only at projects you accept an agent editing.
- Model judgements (design review, the SQL check) can vary between runs; the plain-code checks are what stay fixed.
- Rate limits, auth and billing errors stop the run (the SDK's `is_error` is checked). `error_max_structured_output_retries` is retried once (`config.maxStructuredOutputRetries`); nothing else is.
- Turn and USD caps per stage (`src/config.ts`) are based on a few measured runs. Tune them with your own data.
