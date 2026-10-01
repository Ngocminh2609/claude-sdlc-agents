import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { runStructuredQuery } from "../sdk-helpers.js";
import { config } from "../config.js";
import { indexPromptSection, withIndexAccess } from "../project-index.js";
import { rootsOf, secondaryRootDirs, targetRootsPromptSection } from "../target-roots.js";
import type { ProjectContext, SpecInput } from "../types.js";

/**
 * Scans the target project once, before Specs & Arch, and shares the result
 * with every later stage in a feature-spec run — the same "scan once, share
 * the list" principle clone mode already applies to `--reference` repos
 * (`reference-inventory.ts`) and to the target's own layout
 * (`target-conventions.ts`), applied here to the project a spec is being
 * implemented against. Without it, specs-arch (up to 3 attempts),
 * task-breakdown, every coding task and e2e each rediscover the same project
 * from scratch in their own session.
 *
 * Two different questions, answered in one pass over the same tree:
 * - conventions: how the project is organised — the same answer no matter
 *   which spec is run against it.
 * - relevantFiles: which existing files/helpers THIS spec's work should read
 *   or reuse — changes with the spec, unlike conventions.
 *
 * Null on a failed/empty scan, same as reference-inventory: a degraded run,
 * not a broken one. Every consuming stage still has its own Read/Glob/Grep
 * and can fall back to exploring the project on its own.
 */

const SYSTEM_PROMPT = `You are the Project Context agent in an automated SDLC pipeline.
Read the target project in the current working directory and produce two things
that later stages (design, task breakdown, coding, and the "how to start this
project" part of QA) will use instead of re-exploring the project themselves:

1. conventions — how the project is organised: top-level layout, module/package
   structure, naming and casing conventions actually used (quote real examples),
   and how the project is started/built/tested (the scripts or commands, read
   from package.json or equivalent). Also find the project's actual CI/CD config
   (.gitlab-ci.yml, .github/workflows/*, Jenkinsfile, azure-pipelines.yml,
   bitbucket-pipelines.yml, or a Dockerfile it invokes) and quote the exact
   build/lint/test commands and flags it runs and the toolchain version it's
   pinned to — that is the real gate later coding and E2E work has to pass, which
   can differ from what looks buildable locally. Say plainly when a stage you'd
   expect (lint, type-check, unit tests) is disabled or missing there. Report
   what the project does, not what it should do.
2. relevantFiles — existing files this spec's work should read, follow, or
   reuse: helpers, utilities, base classes, similar existing features,
   configuration the new work must integrate with. This is about what THIS
   spec touches, not a general project tour — be exhaustive for what's
   relevant, and leave out what the spec doesn't touch.

Do not propose a design and do not write or edit anything — this stage only
reports facts about the project as it exists today.`;

const PROJECT_CONTEXT_SCHEMA = {
  type: "object",
  properties: {
    conventions: { type: "string" },
    relevantFiles: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          role: { type: "string" },
        },
        required: ["path", "role"],
      },
    },
    notes: { type: "string" },
  },
  required: ["conventions", "relevantFiles", "notes"],
};

export async function inventoryProjectContext(spec: SpecInput): Promise<ProjectContext | null> {
  const options: Options = {
    systemPrompt: SYSTEM_PROMPT,
    allowedTools: ["Read", "Glob", "Grep"],
    model: config.model,
    maxTurns: config.maxTurns.projectContext,
  };

  // Separate BE/FE folders: both are the project, so both are scanned. The
  // conventions then say which side holds what — later stages rely on that.
  const roots = rootsOf(spec);
  const secondary = secondaryRootDirs(roots);
  if (secondary.length) options.additionalDirectories = secondary;
  withIndexAccess(options, spec.projectIndexes);

  const prompt = [
    "--- Spec (what the work has to produce) ---",
    spec.specMarkdown,
    ...targetRootsPromptSection(roots),
    ...indexPromptSection(spec.projectIndexes),
    "",
    "Read the target project (the current working directory, plus any other target folder listed",
    "above) and produce the conventions summary and the relevant-files list described in your",
    "system prompt. With separate folders, describe each one's conventions and say which folder",
    "each relevant file is in.",
  ].join("\n");

  const result = await runStructuredQuery<ProjectContext>(prompt, options, PROJECT_CONTEXT_SCHEMA);
  if (!result.ok || !result.data) return null;
  return result.data;
}

/**
 * Prompt block for stages that consume the scan. `includeRelevantFiles: false`
 * is for the E2E stage: it may see how the project is organised (so it isn't
 * re-deriving the start command), but the relevant-files list is a coding
 * concern — folding it in would blur E2E's independence from what the Coding
 * stage did.
 */
export function projectContextPromptSection(
  context?: ProjectContext | null,
  opts: { includeRelevantFiles?: boolean } = {},
): string[] {
  if (!context) return [];
  const { includeRelevantFiles = true } = opts;

  const section = [
    "",
    "--- Project context (from a prior scan of this project — treat it as a starting point, read a file yourself if you need more than this summary) ---",
    "",
    "Conventions:",
    context.conventions,
  ];

  if (includeRelevantFiles && context.relevantFiles.length) {
    section.push(
      "",
      "Relevant existing files to read or reuse:",
      ...context.relevantFiles.map((file) => `- ${file.path} — ${file.role}`),
    );
  }

  if (context.notes.trim()) section.push("", `Notes: ${context.notes.trim()}`);

  return section;
}
