import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { runStructuredQuery } from "../sdk-helpers.js";
import { config } from "../config.js";
import type { IssueTask, QaVerdict } from "../types.js";

const SYSTEM_PROMPT = `You are the QA/Tester agent in an automated SDLC pipeline.
Independently verify the implementation against the ORIGINAL issue, not the
developer's claims. Run the test suite, check edge cases and acceptance
criteria implied by the issue, and look for anything the implementation
missed. You cannot edit files — only report what you find.`;

const QA_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "fail"] },
    summary: { type: "string" },
    failedChecks: { type: "array", items: { type: "string" } },
  },
  required: ["verdict", "summary"],
};

export async function runQa(issue: IssueTask, proposal: string): Promise<QaVerdict> {
  // Deliberately a fresh query() call (no continue/resume) so this stage has
  // no memory of the Coding stage's own session — independent verification.
  const options: Options = {
    systemPrompt: SYSTEM_PROMPT,
    allowedTools: ["Read", "Bash", "Glob", "Grep"],
    disallowedTools: ["Write", "Edit"],
    model: config.model,
    maxTurns: config.maxTurns.qa,
  };

  const prompt = [
    `Issue #${issue.number}: ${issue.title}`,
    "",
    issue.body,
    "",
    "--- Design proposal the implementation should satisfy ---",
    proposal,
  ].join("\n");

  const result = await runStructuredQuery<QaVerdict>(prompt, options, QA_SCHEMA);
  if (!result.ok || !result.data) {
    // Fail-closed: an unparseable/unavailable verdict is treated as a fail,
    // not a silent pass.
    return {
      verdict: "fail",
      summary: `QA stage failed to produce a verdict: ${result.error ?? "unknown error"}`,
    };
  }
  return result.data;
}
