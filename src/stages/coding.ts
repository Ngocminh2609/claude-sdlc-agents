import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { runTextQuery } from "../sdk-helpers.js";
import { databasePromptSection } from "../database-scripts.js";
import { config, networkExfilBashBlocklist } from "../config.js";
import { indexPromptSection, withIndexAccess } from "../project-index.js";
import { CODE_QUALITY_RULES } from "../prompts/code-quality.js";
import { metadataStandardsPromptSection } from "../metadata-standards.js";
import { skillCatalogPromptSection, withSkillDirs } from "../skills-catalog.js";
import { runtimePortsPromptSection } from "../prompts/runtime-ports.js";
import { StageError } from "../stage-error.js";
import { extraDirectories, isInsideReference, referencePromptSection } from "../reference-repos.js";
import { rootsOf, targetRootsPromptSection } from "../target-roots.js";
import { projectContextPromptSection } from "./project-context.js";
import type { CompletedTask, ProjectContext, ReferenceInventory, SpecInput, TaskItem } from "../types.js";

const SYSTEM_PROMPT = `You are the Coding agent in an automated SDLC pipeline.
Implement the assigned task from the approved design: write the application
code, then confirm it actually works by exercising the main flow directly —
run the app (or the relevant part of it) and drive the new/changed behavior
yourself (a request against the new endpoint, a script invoking the new
function, a build-and-run smoke check), the way a person would try it by
hand. Cover the happy path and the obvious failure case (bad input, not
found), not an exhaustive matrix. Do not write a persisted unit test file for
this: the pipeline's own end-to-end stage, run once after every task in this
pass is done, proves the whole feature against the spec's acceptance
criteria through a real browser — a per-task test file would duplicate that
proof at the cost of a slower loop, not add a check that stage does not
already make. If your change breaks an existing test already in the repo,
fix the root cause — never weaken the assertion or skip the test to make the
suite pass. Do not create or edit any files under an "e2e/" directory or
named "*.spec.ts" — those belong to the independent E2E/QA stage that runs
after you. Keep changes scoped to your assigned task.

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
 * Keeps output out of the reference repositories and the global skills
 * directory.
 *
 * `additionalDirectories` (below) grants read *and* write to those trees, but
 * "reference" here means read-only: a run must never modify the project it is
 * copying patterns from, or the FIS skill catalog it is told to follow. Same
 * mechanism the E2E stage uses — and, as noted there, Write/Edit have to stay
 * OUT of `allowedTools`, because a tool listed there bypasses `canUseTool`
 * entirely.
 *
 * Residual gap, stated rather than papered over: Bash is allowed, so a shell
 * command could still write into one of these trees. The prompt forbids it
 * and this closes the direct path; parsing arbitrary shell to close the rest
 * is not something a permission callback can do honestly.
 */
export function guardReferenceRepos(referencePaths: string[] | undefined, readOnlyDirs: string[] = []): CanUseTool {
  const guarded = [...(referencePaths ?? []), ...readOnlyDirs];
  return async (toolName, input) => {
    if (toolName === "Write" || toolName === "Edit") {
      const filePath = String((input as { file_path?: string }).file_path ?? "");
      if (isInsideReference(filePath, guarded)) {
        return {
          behavior: "deny",
          message:
            "That path is read-only (a reference repository or the skills catalog). Write into the target project (the current working directory) instead.",
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
    canUseTool: guardReferenceRepos(spec.referencePaths, spec.skillCatalog?.readOnlyDirs),
    systemPrompt: SYSTEM_PROMPT,
    model: config.model,
    maxTurns: config.maxTurns.coding,
  };

  // Reference repos and the skills catalog are readable only (canUseTool
  // above); a second target folder (FE when BE is the working directory) is
  // readable and writable.
  const roots = rootsOf(spec);
  const extraDirs = withSkillDirs(extraDirectories(spec.referencePaths, roots), spec.skillCatalog);
  if (extraDirs.length) options.additionalDirectories = extraDirs;
  withIndexAccess(options, spec.projectIndexes);

  const parts = [
    "--- Spec ---",
    spec.specMarkdown,
    ...targetRootsPromptSection(roots),
    ...databasePromptSection(spec.database, "code"),
    "",
    "--- Approved design (implement your task within it; do not redesign) ---",
    approvedProposal,
    ...referencePromptSection(spec.referencePaths, inventory),
    ...indexPromptSection(spec.projectIndexes),
    ...projectContextPromptSection(projectContext),
    ...metadataStandardsPromptSection(spec.metadataStandards, "code"),
    ...skillCatalogPromptSection(spec.skillCatalog),
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
