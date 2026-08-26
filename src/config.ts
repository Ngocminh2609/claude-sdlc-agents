export const config = {
  maxSpecAttempts: 3,
  maxCodingAttempts: 3,
  model: process.env.CLAUDE_MODEL ?? "claude-sonnet-5",
  playwrightTestCommand: "npx playwright test",
  maxTurns: {
    specsArch: 15,
    orchestratorReview: 10,
    taskBreakdown: 10,
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
