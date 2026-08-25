import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { runStructuredQuery } from "../sdk-helpers.js";
import { config } from "../config.js";
import type { IssueTask, ReviewVerdict } from "../types.js";

const SYSTEM_PROMPT = `You are the Orchestrator (tech lead) in an automated SDLC pipeline.
Review the proposed design against the original issue. Approve only if the
proposal fully addresses the issue and has no significant risk. Otherwise
reject with specific, actionable feedback the Specs & Arch agent can act on.`;

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["approve", "reject"] },
    feedback: { type: "string" },
    concerns: { type: "array", items: { type: "string" } },
  },
  required: ["decision", "feedback"],
};

export async function reviewSpecs(issue: IssueTask, proposal: string): Promise<ReviewVerdict> {
  const options: Options = {
    systemPrompt: SYSTEM_PROMPT,
    allowedTools: ["Read", "Glob", "Grep"],
    model: config.model,
    maxTurns: config.maxTurns.orchestratorReview,
  };

  const prompt = [
    `Issue #${issue.number}: ${issue.title}`,
    "",
    issue.body,
    "",
    "--- Proposed design ---",
    proposal,
  ].join("\n");

  const result = await runStructuredQuery<ReviewVerdict>(prompt, options, REVIEW_SCHEMA);
  if (!result.ok || !result.data) {
    // Fail-closed: an unparseable/unavailable verdict is treated as a rejection,
    // not a silent approval.
    return {
      decision: "reject",
      feedback: `Orchestrator review failed to produce a verdict: ${result.error ?? "unknown error"}`,
    };
  }
  return result.data;
}
