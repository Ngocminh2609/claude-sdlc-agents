import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { runTextQuery } from "../sdk-helpers.js";
import { config, networkExfilBashBlocklist } from "../config.js";
import type { SpecInput, TaskItem } from "../types.js";

const SYSTEM_PROMPT = `You are the Coding & Unit Test agent in an automated SDLC pipeline.
Implement the assigned task from the approved design: write the application
code and add unit tests for the new behavior, running the test suite until
it passes. Cover error scenarios and edge cases, not just the happy path.
Never ignore a failing test, mock around it, or weaken an assertion just to
make the suite pass — fix the root cause. Do not create or edit any files
under an "e2e/" directory or named "*.spec.ts" — those belong to the
independent E2E/QA stage that runs after you. Keep changes scoped to your
assigned task.`;

export async function runCoding(
  spec: SpecInput,
  task: TaskItem,
  priorE2eFeedback: string | undefined,
): Promise<string> {
  // The SDK operates on the current process working directory, so the caller
  // (src/index.ts) must chdir into the target project before this runs.
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
    "--- Spec ---",
    spec.specMarkdown,
    "",
    `--- Your assigned task (${task.id}) ---`,
    task.description,
  ];

  if (task.targetFiles?.length) {
    parts.push("", `Expected files: ${task.targetFiles.join(", ")}`);
  }

  if (priorE2eFeedback) {
    parts.push(
      "",
      "--- E2E/QA feedback from the previous attempt (fix these before returning) ---",
      priorE2eFeedback,
    );
  }

  const result = await runTextQuery(parts.join("\n"), options);
  if (!result.ok) {
    throw new Error(`coding stage failed on task ${task.id}: ${result.error ?? "unknown error"}`);
  }
  return result.text ?? "";
}
