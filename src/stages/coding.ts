import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { runTextQuery } from "../sdk-helpers.js";
import { config, networkExfilBashBlocklist } from "../config.js";
import { indexPromptSection, withIndexAccess } from "../project-index.js";
import { CODE_QUALITY_RULES } from "../prompts/code-quality.js";
import { metadataStandardsPromptSection } from "../metadata-standards.js";
import { runtimePortsPromptSection } from "../prompts/runtime-ports.js";
import { StageError } from "../stage-error.js";
import { extraDirectories, isInsideReference, referencePromptSection } from "../reference-repos.js";
import { rootsOf, targetRootsPromptSection } from "../target-roots.js";
import { projectContextPromptSection } from "./project-context.js";
import type { CompletedTask, ProjectContext, ReferenceInventory, SpecInput, TaskItem } from "../types.js";

const SYSTEM_PROMPT = `You are the Coding & Unit Test agent in an automated SDLC pipeline.
Implement the assigned task from the approved design: write the application
code and add unit tests for the new behavior, running the test suite until
it passes. Cover error scenarios and edge cases, not just the happy path.
Never ignore a failing test, mock around it, or weaken an assertion just to
make the suite pass — fix the root cause. Do not create or edit any files
under an "e2e/" directory or named "*.spec.ts" — those belong to the
independent E2E/QA stage that runs after you. Keep changes scoped to your
assigned task.

Other agents implement the other tasks of the same design, each in its own
session, before and after you. Follow the approved design and the interfaces
that already exist rather than inventing your own: when an earlier task
created an endpoint, a DTO or a table, use exactly those names — read the
code it wrote if its summary does not say enough.

${CODE_QUALITY_RULES}`;

/**
 * A previous task's summary is that agent's own free-text report, which can
 * run long. Cap each one: the point is to carry names and decisions forward,
 * and a full transcript of every earlier task would crowd out the actual task.
 */
const MAX_SUMMARY_CHARS = 1200;

type CanUseTool = NonNullable<Options["canUseTool"]>;

export interface CodingRequest {
  spec: SpecInput;
  task: TaskItem;
  /** The design the Orchestrator approved — each task implements part of it. */
  approvedProposal: string;
  /** Tasks already finished in this pass, in order. */
  completedTasks: CompletedTask[];
  /** The reference file list, when a reference repo was scanned. */
  inventory?: ReferenceInventory | null;
  /** The one-time scan of the target project itself, shared across the whole run. */
  projectContext?: ProjectContext | null;
  /** Ports checked free just before this call, for any server the task starts. */
  runtimePorts?: number[];
}

/**
 * Keeps output out of the reference repositories.
 *
 * `additionalDirectories` (below) grants read *and* write to those trees, but
 * "reference" here means read-only: a run must never modify the project it is
 * copying patterns from. Same mechanism the E2E stage uses — and, as noted
 * there, Write/Edit have to stay OUT of `allowedTools`, because a tool listed
 * there bypasses `canUseTool` entirely.
 *
 * Residual gap, stated rather than papered over: Bash is allowed, so a shell
 * command could still write into a reference tree. The prompt forbids it and
 * this closes the direct path; parsing arbitrary shell to close the rest is
 * not something a permission callback can do honestly.
 */
export function guardReferenceRepos(referencePaths: string[] | undefined): CanUseTool {
  return async (toolName, input) => {
    if (toolName === "Write" || toolName === "Edit") {
      const filePath = String((input as { file_path?: string }).file_path ?? "");
      if (isInsideReference(filePath, referencePaths)) {
        return {
          behavior: "deny",
          message:
            "Reference repositories are read-only. Write into the target project (the current working directory) instead.",
        };
      }
      return { behavior: "allow" };
    }
    return { behavior: "deny", message: `Tool "${toolName}" is not permitted in the Coding stage.` };
  };
}

export async function runCoding(request: CodingRequest): Promise<string> {
  const { spec, task, approvedProposal, completedTasks, inventory, projectContext, runtimePorts = [] } =
    request;

  // The SDK operates on the current process working directory, so the caller
  // (src/index.ts) must chdir into the target project before this runs.
  const options: Options = {
    // Write/Edit are deliberately absent — gated by canUseTool instead.
    allowedTools: ["Read", "Glob", "Grep", "Bash"],
    disallowedTools: [
      "Bash(git commit*)",
      "Bash(git push*)",
      "Bash(git branch*)",
      "Bash(git checkout*)",
      ...networkExfilBashBlocklist,
    ],
    canUseTool: guardReferenceRepos(spec.referencePaths),
    systemPrompt: SYSTEM_PROMPT,
    model: config.model,
    maxTurns: config.maxTurns.coding,
  };

  // Reference repos are readable only (canUseTool above); a second target
  // folder (FE when BE is the working directory) is readable and writable.
  const roots = rootsOf(spec);
  const extraDirs = extraDirectories(spec.referencePaths, roots);
  if (extraDirs.length) options.additionalDirectories = extraDirs;
  withIndexAccess(options, spec.projectIndexes);

  const parts = [
    "--- Spec ---",
    spec.specMarkdown,
    ...targetRootsPromptSection(roots),
    "",
    "--- Approved design (implement your task within it; do not redesign) ---",
    approvedProposal,
    ...referencePromptSection(spec.referencePaths, inventory),
    ...indexPromptSection(spec.projectIndexes),
    ...projectContextPromptSection(projectContext),
    ...metadataStandardsPromptSection(spec.metadataStandards, "code"),
    "",
    `--- Your assigned task (${task.id}) ---`,
    task.description,
  ];

  if (task.targetFiles?.length) {
    parts.push("", `Expected files: ${task.targetFiles.join(", ")}`);
  }

  if (completedTasks.length) {
    parts.push("", "--- Already implemented in this pass by other agents, in order ---");
    for (const done of completedTasks) {
      parts.push(`- ${done.id} (${done.description}): ${truncate(done.summary)}`);
    }
  }

  parts.push(...runtimePortsPromptSection(runtimePorts));

  const result = await runTextQuery(parts.join("\n"), options);
  if (!result.ok) {
    throw new StageError(`coding stage failed on task ${task.id}: ${result.error ?? "unknown error"}`);
  }
  return result.text ?? "";
}

function truncate(summary: string): string {
  const text = summary.trim();
  return text.length <= MAX_SUMMARY_CHARS ? text : `${text.slice(0, MAX_SUMMARY_CHARS)}… (truncated)`;
}
