import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { runTextQuery } from "../sdk-helpers.js";
import { config } from "../config.js";
import type { SpecInput } from "../types.js";

const SYSTEM_PROMPT = `You are the Specs & Arch agent in an automated SDLC pipeline.
Read the spec document and the existing project (current working directory),
then write a concise design proposal:
- Approach and the files you plan to touch
- Key risks or edge cases
- Out-of-scope notes, if any
- If the spec implies distinct, separable pieces of work (e.g. multiple API
  endpoints or features), call that out explicitly so it can be broken into
  tasks later.
Do not write or edit any code — this stage only produces the proposal text.`;

function dbContext(spec: SpecInput): string[] {
  if (!spec.dbInfo) return [];
  const label = spec.dbInfo.kind === "connection" ? "Existing database connection" : "Database schema file";
  return ["", `--- ${label} ---`, spec.dbInfo.value];
}

export async function runSpecsArch(
  spec: SpecInput,
  priorProposal: string | null,
  reviewerFeedback: string | undefined,
): Promise<string> {
  const options: Options = {
    systemPrompt: SYSTEM_PROMPT,
    allowedTools: ["Read", "Glob", "Grep"],
    model: config.model,
    maxTurns: config.maxTurns.specsArch,
  };

  const parts = ["--- Spec ---", spec.specMarkdown, ...dbContext(spec)];

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
