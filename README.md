# claude-sdlc-agents

Local multi-agent software-engineering pipeline built on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview). You run it against a spec document and a target project directory; it implements the spec and verifies it by actually running the project through a real browser (Playwright). A failed verification stops the run and reports what failed — it does not loop back and re-code.

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
                                 Coding (once per task) ──> E2E/QA (Playwright, real browser)
                                        │ a task fails                │ fail        │ pass
                                        ▼                             ▼             ▼
                  stop: which task, why, what finished                stop: what failed    done — files on disk,
                                                                                           git left to you
```

If the Orchestrator never approves a design, a coding task fails, or E2E/QA fails, the pipeline stops and prints why — it never pretends something is done when it isn't, and it never touches git.

Nothing after the design review is retried automatically. An earlier version re-coded every task from the first one after an E2E failure; on a real 8-task run that re-spent the whole coding budget, hit the account's usage limit, and crashed. Now a failure stops the run with the failing task or scenarios, the tasks already finished (their code stays on disk), and the SDK's reason code — `rate_limit` means wait for the usage limit to reset, `error_max_turns` means the stage ran out of turns. The next run's Project Context stage reads whatever is already on disk.

**Design review: approve, approve with amendments, or reject.** The reviewer used to have only approve/reject, so any small gap — even one it could state the exact fix for — cost a full redesign round, and with rounds capped at 3 a real run was escalated on a design the reviewer itself called approved "apart from one addendum". Now a sound design with small, precisely-stated gaps is approved with `amendments`: exact fixes that are appended to the approved design, so the breakdown, every coding task and E2E all see them. Reject is reserved for a design that needs rethinking.

**Resuming a stopped run.** Progress is saved after the project scan, after every rejected design round (a resumed run keeps revising the last proposal with its feedback, instead of designing from nothing), after the task breakdown and after every finished task (clone mode: after the mapping and after every ported group) — to `runs/.checkpoint-<kind>-<hash>.json`, never into the target project, and never with a `--db-connection` value in it. It is written step by step rather than at the end because the end is what a killed run (Stop, out of memory, a crash) never reaches. Running the same spec against the same project again picks up from there: design, review, breakdown and the finished tasks are skipped, and the report says what was reused. It starts over instead when the spec (or reference repos) changed since, when every file the finished tasks wrote has been deleted, or when you pass `--fresh` (UI: "Chạy lại từ đầu"). A run that finishes successfully clears its saved progress; one that stops at E2E keeps it, so running again goes straight to E2E.

**Ports.** Every Coding and E2E session — and in clone mode every port group and the build check — is handed a set of TCP ports checked free just before it starts (`src/free-ports.ts`), and told to start the app's servers on those via env vars or CLI flags rather than on defaults — a machine running other projects often has 8080 or 5173 taken, and a real run lost its whole E2E budget to exactly that. The agent is told never to kill a process it did not start, and to stop the servers it started before finishing.

## How it's built

This repo calls the Agent SDK's `query()` directly (see `src/stages/`) rather than using the official `anthropics/claude-code-action` wrapper — that wrapper runs one continuous session responding to `@claude` mentions, and doesn't expose the hard approval gates this pipeline needs between stages.

There is **no GitHub integration** in this version: no issue trigger, no GitHub Actions workflow, no automated commit or push. You invoke it as a local CLI command against any project directory, and you commit the result yourself after reviewing it.

Prompt text shared by more than one stage lives in `src/prompts/`. `code-quality.ts` holds the clean-code, DRY/KISS/YAGNI, formatting, and CI/CD-hygiene rules — reuse before writing, extract on the second real occurrence, prefer the plainest implementation, build only what was asked, mirror the pipeline's actual build/lint/test commands, wire a new module into every place its siblings are registered, keep lockfiles and generated contracts in sync — and both the Specs & Arch and Coding stages append it to their system prompt, so the design plans for reuse and the implementation writes clean, pipeline-safe code the first time instead of leaving a cleanup pass for afterwards. Project-specific conventions (naming, layering, framework idioms) belong in your spec document, not in that file: it ships with the pipeline and runs against every target repo.

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

**Separate BE and FE folders.** Instead of one `--project`, give `--project-be <dir>` and/or `--project-fe <dir>` — for a server and a client that live in different repos, or to keep a run from scanning a whole monorepo root. The BE folder becomes the working directory and the FE folder is opened to every stage on top of it (readable and writable, unlike reference repos); each stage is told which folder holds what. The same folder given for both is treated as one project. The UI has a BE box and an FE box for this in both modes.

```bash
aidev --spec ./specs/my-feature.md --project-be D:/app/backend --project-fe D:/app/frontend
```

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
- **Escalation / stop**: it prints why it stopped (design never approved, a coding task failed, or E2E/QA failed) and exits non-zero. Code already written stays on disk for you to inspect and finish by hand — nothing is reverted.

Every run — success, escalation, or crash — writes a full log to `runs/<timestamp>-<project>-<spec>/` in **this** repo (not the target project): `log.json` (structured) and `report.md` (every proposal, review decision, task, coding attempt, and E2E verdict with acceptance-criteria evidence). The path is printed at the end. The raw value of `--db-connection` is never written to it (only whether one was provided) — a run log is not a safe place for a real credential. `runs/` is not gitignored on purpose, since it's the audit trail of what the AI actually did; commit it or not, that's your call.

## Metadata standards (opt-in)

For statistical-metadata projects (NSO-SMR / CSDL Đặc tả & Vi mô), a target can opt in to the rules in [`docs/metadata-standards-ai-guidelines.md`](docs/metadata-standards-ai-guidelines.md): DDI-L 3.3, GSIM 2.0, GSBPM, classifications, statistical disclosure control and object-level ACL. To opt in, commit `.metadata-standards.yml` at the target folder root:

```yaml
guideline_version: "1.1"
mode: strict            # strict | advisory (advisory: apply to new code, only report on existing code)
modules: [CORE, DDI, GSIM, CLS, GSBPM, SDC, AUTHZ, NSO]
decisions:
  D5_authz_impl: spring-security-acl
agency: "vn.gso"
waivers: []
```

The file is read automatically — no flag needed for the common case:
- **No file, or `modules: []` / `none`:** nothing is added to any prompt. The run behaves as before.
- **With the file:** only the guideline sections for the listed modules, plus the shared sections §0/§2/§3, go into the Specs & Arch, Orchestrator review, Coding, Clone Port and Clone Fix prompts, together with the config text.
- **Clone Port stays faithful to the source in both modes.** It reports standard violations in the ported code instead of restructuring that code.
- Every run prints one line stating whether the standards applied.
- Changing the config invalidates a saved feature plan, because the design was reviewed against the old rules.
- **Split BE/FE targets:** the two folders may each have the file, but the contents must be identical.

**Per-run override:** `--no-metadata-standards` (UI: the *"Áp dụng metadata standards"* selectbox, set to *"Không"*) skips the file entirely for that one run, even when the target commits one — it does not edit or delete the file, and a run without the flag goes back to reading it. Use it to see how a run behaves without the rules without touching the repo's own config. The progress line then says explicitly that it was skipped by request, so the log never reads as "no config found" when one genuinely exists. This also invalidates a saved plan the same way changing the file would, since the design was (or wasn't) reviewed against the rules either way.

The full template and the decisions D1–D9 are in §1.4 and §2.2 of the guideline.

## FIS skill routing (automatic, always on)

Specs & Arch, Orchestrator review, Task breakdown, Coding, E2E/QA, Clone Mapping, Clone Port and Clone Fix are each shown a short list of installed FIS skills — name and one-line description only, never the full skill content — and told to route to a matching one the same way any other session in this environment does: read the description, and if it clearly covers what the stage is about to do, `Read` that skill's `SKILL.md` and follow it for that part of the work. No skill matches → the stage proceeds exactly as it did before this existed.

Two sources, merged (a same-named project skill wins over a same-named global one):
- **Global:** `~/.claude/skills` on the machine running `aidev` — the full FIS AI Kit.
- **Project-local:** each target folder's own `.claude/skills` — a repo's own scaffolds or overrides.

There is no config for this — it is not a project decision the way the metadata standards are, so it needs no opt-in. A repo with neither directory gets an empty catalog, which is the same "not found, skip" behaviour as always. The global directory is opened read-only to every wired stage (like a reference repo) so the agent can actually read an entry from it; Coding and Clone Port/Fix refuse to `Write`/`Edit` into it. Changing the catalog, or which skills rank as relevant, invalidates a saved feature or clone plan, the same as a metadata standards change.

**Relevance filtering and the size cap.** Every installed skill is scored against the task text — the whole spec for a feature run, `--what` for a clone run — by plain keyword overlap (a skill's own `keywords` frontmatter counts for more than words picked out of its name or description), diacritic- and case-insensitive so it still works against a Vietnamese spec. Only skills that score above zero are kept, ranked highest first, and capped at `config.maxSkills` (6). A skill with no overlap at all is dropped, not kept as filler — "not relevant" gets the same "skip" treatment as "not installed". Every run prints how many skills were installed versus how many were judged relevant.

**Known limitation:** `clone --what` is usually a short phrase (often Vietnamese) with little token overlap against this kit's English keywords, so clone-mode filtering leans on whatever else is in `--what` more than it can lean on the phrase alone — a run with a generic `--what` can end up with an empty, correctly-behaved-but-unhelpful catalog on Clone Mapping, Clone Port and Clone Fix alike (all three rank against the same `--what` text). Mentioning the technology by name in `--what` helps it match; there is no other clone-mode signal fed into ranking today.

**Cost, measured on a real target.** Unfiltered, CSDL-VIMO's 48-entry combined catalog cost ~14.5K characters per stage call. Filtered against a realistic Spring Boot + React spec, it drops to ~2.2K characters (6 skills) — on top of whatever the metadata standards module adds, e.g. the Coding stage there goes from ~27K (metadata standards alone) to ~30K (both). Raise or lower the cap in `config.maxSkills` if that trade-off needs to move.

## Web UI

Same pipeline, driven from a browser instead of a terminal:

```bash
aidev ui                 # http://127.0.0.1:4319, opens your browser
aidev ui --port 5000 --no-open
```

On Windows, double-clicking `aidev-ui.cmd` in this repo does the same thing. The
console window it opens *is* the server — close it to stop the UI.

**Project index.** Plain code, no model, builds an index of every git repo in the
target and reference folders, stored in `runs/.project-index/`. A parent folder
such as `CSDL-VIMO/` counts as the repos inside it. Each file gets one line: its
path, a kind (controller, service, entity, dto, page, api-client, locale, sql…) and
tags (package/class, `@Table`, `@Tag`, mapped routes, API URLs called, route paths,
exports, `CREATE TABLE` names, Vietnamese UI strings). Every run refreshes it
first. The refresh diffs the cached git HEAD against the current one, adds the
uncommitted and untracked files, and re-reads only files whose size or mtime
moved. That takes a few seconds, not a rescan. Agents are told to Grep the index
and open only the files they need, instead of walking repos with Glob/Grep. Clone
locate also gets the index lines matching the keyword directly in its prompt. On
top of it:

- Target conventions are keyed to the repo's *structure* (directories plus
  `pom.xml` / `package.json` / `application*.yml` / tsconfig), not its HEAD. An
  ordinary commit no longer costs a conventions call.
- Clone locate (same keyword), the feature reference inventory and the project
  context (same spec) are cached against the exact content version of the repos
  they read: HEAD plus uncommitted state. Any change in those repos re-runs them.
  So does *Chạy lại từ đầu* / `--fresh`.

Build or refresh the index ahead of time with `aidev index <folder>...`.

**Token usage.** Every agent call's usage (the SDK's `modelUsage`, subagents
included) is added to a running total that the CLI streams as a `usage` event.
The UI assigns each increase to the stage active at the time. It shows the tokens
and estimated cost under each stage box, with the full split on hover, and the
run total next to the start time. When a run ends, the UI writes
`runs/<run>/usage.json` and appends a *Token usage* section to that run's
`report.md`, so the history list shows the total too. A plain CLI run prints only
the total at the end. The figures are the SDK's estimate, not a bill.

The interface is in **Vietnamese** — the people running it are. The rest of the
repo stays English, and the boundary is enforced rather than assumed: the server
sends ids and error codes (`spec-not-found`, `busy`, …), never display text, and
every user-facing string lives in `src/ui/public/app.js` and `index.html`.

What it gives you over the command line:

- **One tab per flow** — "Làm task mới" (spec → design → code → E2E) and "Clone từ
  dự án khác" (reference repo → mapping → port → coverage/wiring/build/tests) are
  separate tabs, each with its own form, its own Run button, its own saved presets
  and its own next-step guidance — nothing typed on one tab reaches the other's run.
  Pick folders with a file browser instead of retyping absolute paths. The feature
  tab's optional reference repo ("Dự án tham khảo pattern") only lets the agents
  read a sample project for patterns; porting a whole feature is the Clone tab.
- **Live stage view** — which stage is running, the current attempt,
  and every line the pipeline prints, streamed as it happens. One progress/log block
  serves both tabs (there is one pipeline at a time) and is labelled with the flow
  of the run it shows; while any run is going, both Run buttons stay disabled.
- **Stop** — kills the pipeline *and* everything it started (tsx, a dev server the
  E2E stage launched, Playwright browsers), so nothing is left holding a port.
  Files already written to the target project are not reverted, same as a Ctrl-C.
- **Spec editor** — write or edit the spec `.md` in the browser and run it without
  leaving the page.
- **History** — every folder under `runs/` with its `report.md` rendered, including
  runs started from the command line, tagged and filterable by flow.
- **Presets** — save a setup you run often, per flow: a feature preset holds the
  target + spec + reference + DB option, a clone preset holds the target + keyword +
  source folders. Presets saved before the split load as feature presets.
- **Built-in guide** — a "Hướng dẫn" tab covering what each stage does, how to write
  a spec the E2E stage can actually verify, what each stop reason means and what to
  do next, plus the safety boundaries. Each run form is a numbered flow (four
  steps for a feature, three for a clone), and Run stays disabled until you confirm the target project is committed or
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

Separate folders on both sides, and a loose keyword instead of the feature's exact name:

```bash
aidev clone --what "nghề nghiệp" \
            --from-be "D:/Source_Code/FIS/TKDT/BE" --from-fe "D:/Source_Code/FIS/TKDT/FE" \
            --project-be "D:/Source_Code/FIS/CSDL-VIMO/BE" --project-fe "D:/Source_Code/FIS/CSDL-VIMO/FE"
```

`--what` is a keyword, Vietnamese or English, not an identifier. The spellings code
actually uses are generated up front (`nghe_nghiep`, `ngheNghiep`, `NgheNghiep`,
`NGHE_NGHIEP`, ...; `src/keyword-variants.ts`), and the locate stage is told to
translate the keyword and search file, class, table and route names plus i18n files.
When it matches several features the best match is ported and the others are listed
in the report — it does not stop to ask. Each mapping row names the target folder
(`be`/`fe`) its file goes into; coverage checks each file in that folder, and the
build check builds every folder that received files.

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
   4. Port        — group by group, in layer order enforced by code: database scripts,
                    then server, then client. Each client group gets the server routes
                    read from the ported controllers on disk, and is written against them
   5. Coverage    — plain code, no model: does every mapped file exist on disk?
   6. Wiring      — plain code, no model: does every import in a ported client file
                    resolve, and does every API path it calls hit a server controller?
   7. Build       — compile what was touched, and quote the real errors if not
   8. Unit tests  — write and run CRUD unit tests: server controllers (MockMvc /
                    framework test client) and services with mocked repositories,
                    client API functions against a mocked request helper. If the build
                    or tests fail, a fix agent edits the ported code (never the tests)
                    and both re-run, up to `maxCloneFixRounds` (2) rounds
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
- **A deliberate deviation must be declared to count.** When the target's own
  conventions mean a mapped file is not written — a `ServiceImpl` folded into the
  one `@Service` class — the port agent declares it (`merged` + the file that
  holds it, or `not-needed` + why). Coverage then checks the claim on disk: a merge
  counts only if the file it names exists; `not-needed` and anything undeclared
  stay missing.
- **A source file the mapping decides must not be ported at all is `notPorted`, not
  a placeholder path.** A duplicate/read-only sibling variant of a feature (a
  "Kho"/"Niên giám" read-only page next to the "Cổng" full-CRUD one that was
  chosen, say), or a class superseded by an existing target-side equivalent, gets
  `notPorted: true` and a reason in `changes` — not text like `"(none — not
  ported)"` stuffed into `target`. That distinction is load-bearing: it happened
  for real once, and coverage — reading `target` literally as a path to look
  for — correctly-but-wrongly counted every one of those placeholder strings as a
  missing file, reporting a fully-covered port as `incomplete`. `notPorted`
  entries are excluded from `missing` (and from the group Clone Port is even
  asked to do — no turn spent reporting there was nothing to do), but still
  listed in the report for a person to check, the same "verify this claim"
  spirit as a `not-needed` deviation.
- **"The generator will make it later" is not accepted.** An API client the target
  normally generates (`max openapi`, `openapi-generator`) is written by hand now,
  in the generator's own shape (file name from the controller's `@Tag`, function
  names from its methods, the same request helper and typings). A run once left
  it for `pnpm openapi`, which needs the backend running behind the gateway, and
  the ported pages imported files that did not exist. Regenerating later only
  rewrites the file.
- **Wiring is checked by code, even with the build skipped.** Every relative or
  `@/` import in a ported client file must resolve to a file on disk. Every
  `request(...)`/`fetch`/`axios` path in those files, and in the local modules
  they import, must match a controller in the server folder: Spring
  `@*Mapping`, NestJS decorators, or Express routers. Path params match any
  segment, and a client prefix such as a gateway path is allowed. Either failure
  makes the run `incomplete`. This proves the pieces are connected. It does not
  prove request bodies or behaviour are right.
- **Tests judge the fix, not the other way round.** The test agent can write only
  test files (`src/test/`, `__tests__/`, `*.test.*`, `*.spec.*`). The fix agent can
  write anything except those. So neither can make a run green by editing what the
  other one is judged on. A pass with no test files or commands does not count.
  Pass `--no-tests` (UI: *Bỏ qua bước unit test*) to skip this stage. These are
  unit tests with mocks. They show the CRUD path goes through the ported code.
  They do not run it against a real database.
- **The build verdict ignores pre-existing breakage.** Only errors in ported files,
  or errors those files cause, fail it. A TypeScript client is type-checked
  (`tsc --noEmit`), not just bundled.
- **Hand-written schemas get a script entry.** When the target creates its tables
  only by scripts (`ddl-auto: none`/`validate`, or a migration tool), the mapping
  adds a `(new)` entry for the schema script of every ported entity the reference
  has no script for, so the port writes it instead of leaving code that compiles
  but fails on missing tables.
- **E2E is not run.** Freshly ported code usually cannot run yet — no rows, no
  config, no wiring — so a browser test would fail runs whose port was correct and
  complete. The build check is the strongest honest signal at that point, and a run
  that could not be verified reports `incomplete`, never `done`.

## How the E2E/QA stage works

It does not trust the Coding stage's own account of what it verified — the Coding stage checks the main flow by hand as it goes, but writes no persisted test of its own. In a fresh session with no memory of the Coding stage, E2E/QA independently:
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
- **`error_max_structured_output_retries` is the SDK's own retry budget for schema-valid JSON running out, not a bug in a stage's prompt or schema.** Observed for real on a Clone Port group (`SQL:...`) with a large generated-schema `changes` description: the SDK flags the whole result as an error with this subtype, and it surfaces as `SDK reported an error mid-run: error_max_structured_output_retries`. **`runStructuredQuery` (`src/sdk-helpers.ts`) now retries this one subtype automatically**, up to `config.maxStructuredOutputRetries` (default 1) extra attempts — covering every structured-output stage (Task breakdown, Orchestrator review, Clone Mapping, Clone Port, Clone Fix, E2E) with one change, since they all call it. No other failure kind is retried this way (`rate_limit`, auth/billing errors, a thrown exception) — those are not transient the same way, and each retry here is a brand-new session that re-spends the whole stage's own turn budget, not a cheap "ask again for JSON", so the cap stays small on purpose. If a group still fails after using up its retries, re-running the same command (no `--fresh`) still works as a manual retry, resuming past every already-completed stage/group via the checkpoint — confirmed: Locate/Conventions/Mapping and every finished Port group were all "reused from the stopped run", and the failed group ported clean afterward. If the *same* group keeps failing this way, its mapping `changes` text (or the size of what it asks the model to produce as one JSON value) is the first thing to look at, not the pipeline.
- The account hitting its plan usage limit, an auth problem, a billing error, or an outage mid-turn does not make the SDK throw. Per its own types, the affected assistant message carries `error` (e.g. `rate_limit`), and the terminal `result` message can still carry `subtype: "success"` while `is_error` is `true` — a success shape whose text is that notice, not real output. `src/sdk-helpers.ts` checks `is_error` on every result rather than trusting the subtype alone; this was found by hitting it for real, not by reading the docs — a run's own usage limit was hit mid-pipeline, and the Coding stage's "summary" became the literal limit notice, accepted before this check existed.
- The design-review cap (3 attempts) and per-stage `maxTurns` are starting defaults — tune them once you have real run data. E2E got 60 turns after a Spring Boot + Vite run ran out of the original 40 before reaching a verdict; with a single E2E attempt, running out of turns is a stopped run.
- **Prompt injection / secret exfiltration risk (residual, not fully closed).** The spec/DB content flows unsanitized into every stage's prompt. The Coding and E2E stages have `Bash`, and the process's environment carries `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN` — if the Bash tool's subprocess inherits that environment (unverified from this repo), a sufficiently crafted injected instruction (e.g. pasted from a compromised page into the spec) could try to exfiltrate them. `curl`/`wget` are explicitly blocked in `disallowedTools` as a first layer, but a disallow-list can't rule out every network-capable interpreter, so this isn't a complete fix.
- A stage failure the pipeline recognises (a `StageError`, `src/stage-error.ts`: stage, task and the SDK's reason code, all text this repo wrote) is reported verbatim. Anything else thrown mid-run (network failure, SDK bug, etc.) is caught at the top level, logged in full to the console, and reported as a generic "unexpected error" rather than leaking internal error text. Neither is retried; you re-run after dealing with the cause.
- No sandboxing beyond the tool-permission restrictions above: the Coding and E2E stages run with real filesystem and network (minus curl/wget) access in your target project. Only point this at projects/directories you're comfortable an AI agent editing directly.
