export const config = {
  maxSpecAttempts: 3,
  model: process.env.CLAUDE_MODEL ?? "claude-sonnet-5",
  playwrightTestCommand: "npx playwright test",
  // The three planning stages get Read/Glob/Grep and throw on exhaustion,
  // which crashes the pipeline outright — maxSpecAttempts only retries a
  // reviewer rejection, not a stage failure. On a real monorepo (node_modules,
  // Maven target/ trees) the original 15/10/10 budgets were spent on
  // exploration before any output was produced.
  maxTurns: {
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
    e2e: 60,
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
  },
  // Rounds of "fix the ported code, then re-run build and tests" before a
  // clone run gives up and reports incomplete with the remaining failures.
  maxCloneFixRounds: 2,
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
};

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
