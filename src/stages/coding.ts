import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { runTextQuery } from "../sdk-helpers.js";
import { config, networkExfilBashBlocklist } from "../config.js";
import type { IssueTask } from "../types.js";

const SYSTEM_PROMPT = `You are the Coding & Unit Test agent in an automated SDLC pipeline.
Implement the approved design proposal: write the code, add unit tests for the
new behavior, and run the test suite until it passes. Cover error scenarios
and edge cases, not just the happy path. Never ignore a failing test, mock
around it, or weaken an assertion just to make the suite pass — fix the root
cause. Do not run any git commands that create commits, branches, or pushes —
that is handled by the pipeline after QA approval. Keep changes scoped to the
approved proposal.`;

export async function runCoding(
  issue: IssueTask,
  proposal: string,
  priorQaFeedback: string | undefined,
): Promise<string> {
  // The SDK operates on the current process working directory, so the caller
  // (src/index.ts) must chdir into the target repo checkout before this runs.
  const options: Options = {
    systemPrompt: SYSTEM_PROMPT,
    allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
    disallowedTools: [
      "Bash(git commit*)",
      "Bash(git push*)",
      "Bash(git branch*)",
      "Bash(git checkout*)",
      ...networkExfilBashBlocklist,
    ],
    model: config.model,
    maxTurns: config.maxTurns.coding,
  };

  const parts = [
    `Issue #${issue.number}: ${issue.title}`,
    "",
    "--- Approved design proposal ---",
    proposal,
  ];

  if (priorQaFeedback) {
    parts.push(
      "",
      "--- QA feedback from the previous attempt (fix these before returning) ---",
      priorQaFeedback,
    );
  }

  const result = await runTextQuery(parts.join("\n"), options);
  if (!result.ok) {
    throw new Error(`coding stage failed: ${result.error ?? "unknown error"}`);
  }
  return result.text ?? "";
}
