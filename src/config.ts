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
