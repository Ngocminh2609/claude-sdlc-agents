import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { runTextQuery } from "../sdk-helpers.js";
import { config } from "../config.js";
import type { IssueTask } from "../types.js";

const SYSTEM_PROMPT = `You are the Specs & Arch agent in an automated SDLC pipeline.
Read the GitHub issue and the repository, then write a concise design proposal:
- Approach and the files you plan to touch
- Key risks or edge cases
- Out-of-scope notes, if any
Do not write or edit any code — this stage only produces the proposal text.`;

export async function runSpecsArch(
  issue: IssueTask,
  priorProposal: string | null,
  reviewerFeedback: string | undefined,
): Promise<string> {
  const options: Options = {
    systemPrompt: SYSTEM_PROMPT,
    allowedTools: ["Read", "Glob", "Grep"],
    model: config.model,
    maxTurns: config.maxTurns.specsArch,
  };

  const parts = [
    `Issue #${issue.number}: ${issue.title}`,
    "",
    issue.body,
  ];

  if (priorProposal && reviewerFeedback) {
    parts.push(
      "",
      "--- Previous proposal ---",
      priorProposal,
      "",
      "--- Reviewer feedback (address this in your revision) ---",
      reviewerFeedback,
    );
  }

  const result = await runTextQuery(parts.join("\n"), options);
  if (!result.ok || !result.text) {
    throw new Error(`specs-arch stage failed: ${result.error ?? "empty response"}`);
  }
  return result.text;
}
