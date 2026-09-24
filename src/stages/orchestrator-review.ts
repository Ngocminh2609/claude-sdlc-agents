import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { runStructuredQuery } from "../sdk-helpers.js";
import { config } from "../config.js";
import type { ReviewVerdict, SpecInput } from "../types.js";

const SYSTEM_PROMPT = `You are the Orchestrator (tech lead) in an automated SDLC pipeline.
Review the proposed design against the original spec. You have three outcomes:

1. approve — the design fully addresses the spec and has no significant risk.
2. approve WITH amendments — the approach is sound and every remaining gap is a
   small, local fix you can state exactly yourself (a missing config key, a
   parameter to normalize, a sort order to add, choosing between two options you
   can verify in the repo). Set decision "approve" and put each fix in
   "amendments" as a precise, self-contained instruction the coding stage can
   implement without asking — name the file, the change and why. Amendments are
   binding: they become part of the approved design.
3. reject — only when the design would need rethinking: it misses an acceptance
   criterion, takes an approach that conflicts with the codebase, or has a gap
   whose fix you cannot state precisely. Give specific, actionable feedback.

Do not reject over a problem you could have written as an amendment — a
rejection costs a full redesign round and the number of rounds is capped. When
revising, judge whether the design is now sound; do not hunt for fresh
nitpicks that would have been amendments.`;

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["approve", "reject"] },
    feedback: { type: "string" },
    concerns: { type: "array", items: { type: "string" } },
    amendments: { type: "array", items: { type: "string" } },
  },
  required: ["decision", "feedback"],
};

export async function reviewSpecs(spec: SpecInput, proposal: string): Promise<ReviewVerdict> {
  const options: Options = {
    systemPrompt: SYSTEM_PROMPT,
    allowedTools: ["Read", "Glob", "Grep"],
    model: config.model,
    maxTurns: config.maxTurns.orchestratorReview,
  };

  const prompt = [
    "--- Spec ---",
    spec.specMarkdown,
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
