export const config = {
  maxSpecAttempts: 3,
  maxCodingAttempts: 3,
  model: process.env.CLAUDE_MODEL ?? "claude-sonnet-5",
  playwrightTestCommand: "npx playwright test",
  // The three planning stages get Read/Glob/Grep and throw on exhaustion,
  // which crashes the pipeline outright — maxSpecAttempts only retries a
  // reviewer rejection, not a stage failure. On a real monorepo (node_modules,
  // Maven target/ trees) the original 15/10/10 budgets were spent on
  // exploration before any output was produced.
  maxTurns: {
    specsArch: 40,
    orchestratorReview: 25,
    taskBreakdown: 25,
    coding: 60,
    e2e: 40,
  },
};

// Defense-in-depth for stages that get Bash: the spec/DB content flowing
// into every stage prompt could contain pasted text from elsewhere (a doc
// copied from a compromised page, a DB comment field, etc.), and the
// pipeline process's env carries ANTHROPIC_API_KEY. This does not fully
// close the exfiltration risk (Bash can run other network-capable
// interpreters), but it blocks the obvious vector.
export const networkExfilBashBlocklist = ["Bash(curl*)", "Bash(wget*)"];
