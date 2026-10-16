export const config = {
  // One design round per run (user decision, 2026-10-06): every step runs once.
  // A rejected design stops the run with the reviewer's feedback saved; running
  // again revises that proposal instead of the pipeline looping on its own.
  maxSpecAttempts: 1,
  model: process.env.CLAUDE_MODEL ?? "claude-sonnet-5",
  // The SQL optimizer's independent equivalence check (`stages/sql-optimize.ts`)
  // is what protects the business logic, so it gets a strong model even when
  // the proposing step runs on a cheaper one. Env: AIDEV_SQL_CHECK_MODEL.
  sqlCheckModel: process.env.AIDEV_SQL_CHECK_MODEL ?? "claude-opus-5-5",
  playwrightTestCommand: "npx playwright test",
  // The three planning stages get Read/Glob/Grep and throw on exhaustion,
  // which crashes the pipeline outright — maxSpecAttempts only retries a
  // reviewer rejection, not a stage failure. On a real monorepo (node_modules,
  // Maven target/ trees) the original 15/10/10 budgets were spent on
  // exploration before any output was produced.
  maxTurns: {
    // Reads the target to ground a spec in its real modules — the same kind
    // of exploration the design stage does, with no reference tree on top.
    specDraft: 40,
    specsArch: 40,
    // A reference repo is a second tree to walk on the same budget, so the
    // design stage gets more room when one is in play. The inventory stage
    // ahead of it does the bulk of the walking, but the design still opens
    // the files that matter.
    specsArchWithReference: 60,
    // This stage only lists files — no design, no code — but listing them
    // exhaustively across a real repo is exactly what costs turns.
    referenceInventory: 50,
    // Combines what target-conventions and reference-inventory each do for
    // clone mode (organisation + relevant-file listing) into one pass over
    // the target project, so it gets roughly both budgets.
    projectContext: 60,
    orchestratorReview: 25,
    taskBreakdown: 25,
    coding: 60,
    // E2E gets one attempt only (a failure stops the run), and a real app can
    // need several servers started — Spring Boot + a Vite frontend ran out of
    // the original 40 turns before producing any verdict.
    // Measured 2026-10-15/16 on three real runs: 46, 55 and 57 of 60 turns —
    // too close to the cap. The USD cap (maxBudgetUsd.e2e) is unchanged.
    e2e: 80,
    // Clone mode. Reading a whole target project to work out its conventions
    // is exploration-heavy; mapping and porting then work from a decided list,
    // so they spend turns on files rather than on searching.
    targetConventions: 50,
    cloneMapping: 40,
    clonePort: 60,
    cloneBuild: 30,
    // Writing tests for every ported controller, service and API client, then
    // running and correcting them, is the heaviest clone stage after porting.
    cloneTests: 90,
    cloneTestsRerun: 20,
    cloneFix: 60,
    // No tools: the file is in the prompt and the answer is one structured
    // object, so the turns are only the answer and a schema retry or two.
    sqlOptimize: 4,
    // The independent equivalence check of the proposed edits, same shape.
    sqlCheck: 4,
  },
  // Rounds of "fix the ported code, then re-run build and tests" before a
  // clone run gives up and reports incomplete with the remaining failures.
  maxCloneFixRounds: 2,
  // The pipeline's own re-run of the E2E tests starts every app server again
  // (a Spring Boot build can take minutes) and records video for every test.
  e2eCheckTimeoutMs: 20 * 60 * 1000,
  // Hard cap on how many installed FIS skills go into a stage's prompt, after
  // ranking by relevance to the spec (or `clone --what`) — see
  // `skills-catalog.ts`. A machine with dozens of skills installed would
  // otherwise pay for all of them on every call regardless of relevance.
  maxSkills: 6,
  // Extra attempts after `error_max_structured_output_retries` — the SDK's
  // own retry budget for schema-valid JSON exhausted, observed for real on a
  // Clone Port group (see README "Known limitations"). Scoped to only this
  // one subtype (`src/sdk-helpers.ts`), never to `rate_limit`/auth/billing
  // errors or a thrown exception: those are not transient the same way, and
  // this repo deliberately does not retry blind (see the Coding-stage retry
  // loop that once re-spent a whole usage budget, `CLAUDE.md`). Each attempt
  // is a brand-new session — a full re-run of the stage's own turn budget,
  // not a cheap "ask again for JSON" — so this stays small.
  maxStructuredOutputRetries: 1,
  // USD cap per agent step (one `query()`), keyed like `maxTurns`. The SDK
  // stops the session with `error_max_budget_usd`, which stops the run like any
  // other stage error; the step's session is kept, so the next run resumes it.
  // Set at roughly 2–3x what the step cost on the two runs measured on
  // 2026-10-06 (Coding ~$1.4 per task, E2E $2.9–3.4, design ~$1), so a normal
  // step never reaches it and only a runaway one does.
  maxBudgetUsd: {
    specDraft: 3,
    specsArch: 3,
    specsArchWithReference: 4,
    referenceInventory: 3,
    projectContext: 3,
    orchestratorReview: 2,
    taskBreakdown: 2,
    coding: 5,
    e2e: 8,
    targetConventions: 3,
    cloneMapping: 4,
    clonePort: 5,
    cloneBuild: 2,
    cloneTests: 6,
    cloneTestsRerun: 2,
    cloneFix: 4,
    // Not measured yet: a 100K-character file read once and written back once.
    sqlOptimize: 2,
    sqlCheck: 2,
  },
  // Plain-code guards on every agent session's own loop (`src/loop-guard.ts`).
  loopGuard: {
    repeatWarn: 3,
    repeatBlock: 5,
    // Share of a stage's maxTurns after which it is told to wrap up.
    softCapRatio: 0.8,
    maxBashOutputChars: 8000,
  },
  // The build check the pipeline itself runs after each feature Coding task
  // (`src/verify-gate.ts`). By default a failure stops the run — it is not
  // retried (see CLAUDE.md, "Nothing after the design review is retried").
  verifyGate: {
    enabled: true,
    timeoutMs: 15 * 60 * 1000,
    tailLines: 60,
    // Fix rounds per task after a failed check: the task's own session is
    // resumed with the failure, then the check runs again. 0 = stop at the
    // first failure. Each round is a paid Coding session (up to its
    // maxBudgetUsd) — raising it is the person's cost decision. Env:
    // AIDEV_BUILD_FIX_ROUNDS.
    fixRounds: Math.max(0, Math.min(3, Number(process.env.AIDEV_BUILD_FIX_ROUNDS ?? 0) || 0)),
  },
};

export type StageLimitKey = keyof typeof config.maxTurns;

/** A stage's turn and spend caps, for its SDK `Options`. */
export function limitsOf(stage: StageLimitKey): { maxTurns: number; maxBudgetUsd: number } {
  return { maxTurns: config.maxTurns[stage], maxBudgetUsd: config.maxBudgetUsd[stage] };
}

// Defense-in-depth for stages that get Bash: the spec/DB content flowing
// into every stage prompt could contain pasted text from elsewhere (a doc
// copied from a compromised page, a DB comment field, etc.), and the
// pipeline process's env carries ANTHROPIC_API_KEY. This does not fully
// close the exfiltration risk (Bash can run other network-capable
// interpreters), but it blocks the obvious vector.
export const networkExfilBashBlocklist = [
  "Bash(curl*)",
  "Bash(wget*)",
  // Not exfiltration, but the same list reaches every stage with Bash: a
  // whole-filesystem search. In Git Bash, `find /` walks every drive, takes
  // hours, and outlives the agent that started it — observed holding over ten
  // million handles. Agents search the project index or their own folders.
  "Bash(find /*)",
  "Bash(find / *)",
  "Bash(ls -R /*)",
];

// Every stage with a turn cap has a spend cap: a missing key fails to compile.
const budgetCoversEveryStage: Record<StageLimitKey, number> = config.maxBudgetUsd;
void budgetCoversEveryStage;
