import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { runStructuredQuery } from "../sdk-helpers.js";
import { config, networkExfilBashBlocklist } from "../config.js";
import type { IssueTask, QaVerdict } from "../types.js";

const SYSTEM_PROMPT = `You are the QA/Tester agent in an automated SDLC pipeline.
Independently verify the implementation against the ORIGINAL issue, not the
developer's claims. Run the test suite, check edge cases, and look for
anything the implementation missed. You cannot edit files — only report what
you find.

Extract every acceptance criterion stated or implied by the issue and list
each one in "acceptanceCriteria" with concrete evidence (a specific passing
test name, or a manual reproduction step you ran) — not the developer's
say-so. A criterion with no concrete covering evidence must be marked
covered=false. The overall verdict can only be "pass" if every acceptance
criterion is covered=true and the test suite passes; otherwise "fail".`;

const QA_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "fail"] },
    summary: { type: "string" },
    acceptanceCriteria: {
      type: "array",
      items: {
        type: "object",
        properties: {
          criterion: { type: "string" },
          covered: { type: "boolean" },
          evidence: { type: "string" },
        },
        required: ["criterion", "covered", "evidence"],
      },
    },
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
    disallowedTools: ["Write", "Edit", ...networkExfilBashBlocklist],
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
