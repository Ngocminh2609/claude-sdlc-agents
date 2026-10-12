import { existsSync } from "node:fs";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { runTextQuery } from "../sdk-helpers.js";
import { isTestFile } from "../test-files.js";
import { databasePromptSection } from "../database-scripts.js";
import { config, networkExfilBashBlocklist } from "../config.js";
import { indexPromptSection, withIndexAccess } from "../project-index.js";
import { CODE_QUALITY_RULES } from "../prompts/code-quality.js";
import { FEATURE_TEST_POLICY } from "../prompts/feature-test-policy.js";
import { metadataStandardsPromptSection } from "../metadata-standards.js";
import { skillCatalogPromptSection, withSkillDirs } from "../skills-catalog.js";
import { StageError } from "../stage-error.js";
import { extraDirectories, isInsideReference, referencePromptSection } from "../reference-repos.js";
import { rootsOf, targetRootsPromptSection } from "../target-roots.js";
import { projectContextPromptSection } from "./project-context.js";
import { projectMemoryPromptSection } from "../project-memory.js";
import type { CompletedTask, ProjectContext, ReferenceInventory, SpecInput, TaskItem } from "../types.js";

const SYSTEM_PROMPT = `You are the Coding agent in an automated SDLC pipeline.
Implement the assigned task from the approved design: write the application
code, then make sure it compiles and passes the project's formatter and
linter. Do not run the app to try it — the E2E stage, after every task is
done, exercises the whole feature in a real browser. If your change breaks an existing test
already in the repo, fix the root cause — never weaken the assertion or skip
the test to make the suite pass. Do not create or edit any files under an
"e2e/" directory or named "*.spec.ts" — those belong to the independent
E2E/QA stage that runs after you. Keep changes scoped to your assigned task.
If the task description asks for new unit test files, skip that part: the
rule below wins, and creating a new test file is refused.

TOKEN BUDGET — every turn re-sends your whole context, so the cost of this
session is roughly (number of turns) x (context size). Work in few, full turns:
- Batch. Put every independent tool call of a step in ONE response: read all
  the files you need at once (several Read calls side by side), then write or
  edit all independent files at once. One call per turn is the expensive way.
- Read files only with the Read tool, once each. Edit needs a Read anyway, so
  never cat/head/sed/type a file through Bash as well — that pays for it twice.
  For a large file, Read only the range you need (offset/limit).
- Do not explore. The design, your task and the earlier tasks' summaries name
  the files you need. To find where a symbol, route or table lives, Grep the
  project index (one call) instead of listing folders or searching the tree.
- Command output stays in your context for the rest of the session: use quiet
  flags (mvn -q, npm --silent, gradle -q), pipe long output through
  "tail -n 60" or grep for the errors, and run the full build once you are done
  editing rather than after every file.

${FEATURE_TEST_POLICY}

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

/** An earlier task is named by its first line, not its full description. */
const MAX_HEADLINE_CHARS = 160;

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
  /**
   * An earlier session started this task and was stopped before finishing it,
   * and that session could not be resumed (see `step-session.ts`).
   */
  interrupted?: boolean;
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

/**
 * Refuses creating a new test file in feature-mode Coding (see
 * `FEATURE_TEST_POLICY`). Editing a test that already exists stays allowed, so
 * a task that intentionally changes behaviour can keep an existing suite in
 * step instead of being stuck behind it. Only `Write` can create a file.
 */
export function guardNewTestFiles(inner: CanUseTool): CanUseTool {
  return async (toolName, input, context) => {
    if (toolName === "Write") {
      const filePath = String((input as { file_path?: string }).file_path ?? "");
      if (isTestFile(filePath) && !existsSync(filePath)) {
        return {
          behavior: "deny",
          message:
            "New test files are not written in this pipeline — the E2E stage verifies the feature. Verify your task with a build, lint and a short smoke run instead.",
        };
      }
    }
    return inner(toolName, input, context);
  };
}

export async function runCoding(request: CodingRequest): Promise<string> {
  const {
    spec,
    task,
    approvedProposal,
    completedTasks,
    inventory,
    projectContext,
    interrupted = false,
  } = request;

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
    canUseTool: guardNewTestFiles(guardReferenceRepos(spec.referencePaths, spec.skillCatalog?.readOnlyDirs)),
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
    // Conventions only: the relevant-file list was gathered for planning and
    // cost ~20K characters on every turn of every task. Files are looked up
    // in the project index instead.
    ...projectContextPromptSection(projectContext, { includeRelevantFiles: false }),
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
    parts.push(
      "",
      "--- Already implemented in this pass by other agents, in order ---",
      "Each task's files are read back from the project index after it finished (path | kind | tags):",
      "use these names as they are; open a file only when you must change it or need more than its tags.",
    );
    for (const done of completedTasks) {
      // The headline only: a full earlier task description is several thousand
      // characters re-sent on every turn, and its summary and files say what matters.
      parts.push(`- ${done.id} (${headline(done.description)}): ${truncate(done.summary)}`);
      for (const file of done.files ?? []) parts.push(`    ${file}`);
    }
  }
  parts.push(...projectMemoryPromptSection(spec.projectMemory));

  if (interrupted) {
    parts.push(
      "",
      "--- This task was started before and interrupted ---",
      "An earlier session worked on this task and was stopped before it finished (a usage limit, a",
      "crash or Stop). Some of its files may already be on disk, complete or half-written. First look",
      "at what is there (the expected files above, and the files the task's description names), then",
      "continue from it: keep what is correct, finish what is missing, fix what is broken. Do not",
      "rewrite from scratch a file that is already correct.",
    );
  }

  const result = await runTextQuery(parts.join("\n"), options);
  if (!result.ok) {
    throw new StageError(`coding stage failed on task ${task.id}: ${result.error ?? "unknown error"}`);
  }
  return result.text ?? "";
}

/** A task description's first line, capped: what the task was, not how. */
function headline(description: string): string {
  const first = description.trim().split("\n")[0] ?? "";
  return first.length <= MAX_HEADLINE_CHARS ? first : `${first.slice(0, MAX_HEADLINE_CHARS)}…`;
}

function truncate(summary: string): string {
  const text = summary.trim();
  return text.length <= MAX_SUMMARY_CHARS ? text : `${text.slice(0, MAX_SUMMARY_CHARS)}… (truncated)`;
}
