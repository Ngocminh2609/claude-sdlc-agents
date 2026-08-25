export const config = {
  maxSpecAttempts: 3,
  maxCodingAttempts: 3,
  model: process.env.CLAUDE_MODEL ?? "claude-sonnet-5",
  branchPrefix: "ai/issue",
  maxTurns: {
    specsArch: 15,
    orchestratorReview: 10,
    coding: 50,
    qa: 25,
  },
};

// Defense-in-depth for stages that get Bash: the issue body/title flowing
// into every stage prompt is attacker-influenceable (even on a private repo,
// a collaborator could paste injected text unknowingly), and the pipeline
// process's env carries ANTHROPIC_API_KEY/GITHUB_TOKEN. This does not fully
// close the exfiltration risk (Bash can run other network-capable
// interpreters), but it blocks the obvious vector.
export const networkExfilBashBlocklist = ["Bash(curl*)", "Bash(wget*)"];
