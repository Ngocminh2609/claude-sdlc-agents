import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { runStructuredQuery } from "../sdk-helpers.js";
import { config } from "../config.js";
import { referenceDirectories, referencePromptSection } from "../reference-repos.js";
import type { ReferenceInventory, SpecInput, TaskBreakdown } from "../types.js";

const SYSTEM_PROMPT = `You are the Orchestrator, breaking an approved design into an
ordered list of discrete implementation tasks (e.g. one per API endpoint or
feature). Each task must be independently describable and, where possible,
touch a distinct set of files so it can be implemented without conflicting
with the others. If the work is small enough to be one task, return a single
task — do not split for the sake of splitting.`;

const TASK_SCHEMA = {
  type: "object",
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          description: { type: "string" },
          targetFiles: { type: "array", items: { type: "string" } },
        },
        required: ["id", "description"],
      },
    },
  },
  required: ["tasks"],
};

export async function breakDownTasks(
  spec: SpecInput,
  approvedProposal: string,
  inventory?: ReferenceInventory | null,
): Promise<TaskBreakdown> {
  const options: Options = {
    systemPrompt: SYSTEM_PROMPT,
    allowedTools: ["Read", "Glob", "Grep"],
    model: config.model,
    maxTurns: config.maxTurns.taskBreakdown,
  };

  // Read-only stage: the directory list is enough here, no write guard needed.
  const referenceDirs = referenceDirectories(spec.referencePaths);
  if (referenceDirs.length) options.additionalDirectories = referenceDirs;

  const prompt = [
    "--- Spec ---",
    spec.specMarkdown,
    "",
    "--- Approved design ---",
    approvedProposal,
    ...referencePromptSection(spec.referencePaths, inventory),
  ].join("\n");

  const result = await runStructuredQuery<TaskBreakdown>(prompt, options, TASK_SCHEMA);
  if (!result.ok || !result.data || result.data.tasks.length === 0) {
    // Fail-closed to a single task covering the whole proposal, rather than
    // silently dropping work if the breakdown call itself fails.
    return { tasks: [{ id: "task-1", description: approvedProposal }] };
  }
  return result.data;
}
