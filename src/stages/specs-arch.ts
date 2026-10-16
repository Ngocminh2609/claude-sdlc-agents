import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { runTextQuery } from "../sdk-helpers.js";
import { databasePromptSection } from "../database-scripts.js";
import { stageOptions } from "../config.js";
import { indexPromptSection, withIndexAccess } from "../project-index.js";
import { CODE_QUALITY_RULES } from "../prompts/code-quality.js";
import { FEATURE_TEST_POLICY } from "../prompts/feature-test-policy.js";
import { metadataStandardsPromptSection } from "../metadata-standards.js";
import { StageError } from "../stage-error.js";
import { extraDirectories, referenceDirectories, referencePromptSection } from "../reference-repos.js";
import { skillCatalogPromptSection, withSkillDirs } from "../skills-catalog.js";
import { rootsOf, targetRootsPromptSection } from "../target-roots.js";
import { projectContextPromptSection } from "./project-context.js";
import { projectMemoryPromptSection } from "../project-memory.js";
import type { ProjectContext, ReferenceInventory, SpecInput } from "../types.js";

/** Heading of the proposal section that stops the run for a person's answers. */
export const BUSINESS_QUESTIONS_HEADING = "## Business questions";

/**
 * The questions a proposal ends with, or none. Only "- " lines directly under
 * the heading count, up to the next heading; "none"-style lines are ignored.
 */
export function businessQuestionsOf(proposal: string): string[] {
  const lines = proposal.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === BUSINESS_QUESTIONS_HEADING.toLowerCase());
  if (start < 0) return [];
  const questions: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line.trim())) break;
    const item = /^\s*[-*]\s+(.+)$/.exec(line)?.[1]?.trim();
    if (item && !/^(none|n\/a|không có)\.?$/i.test(item)) questions.push(item);
  }
  return questions;
}

const SYSTEM_PROMPT = `You are the Specs & Arch agent in an automated SDLC pipeline.
Read the spec document and the existing project (current working directory),
then write a concise design proposal:
- Approach and the files you plan to touch
- Key risks or edge cases
- Out-of-scope notes, if any
- Which existing helpers, utilities or base classes the work should reuse, and any
  duplication the work would otherwise create — name the shared piece to extract.
- If the spec implies distinct, separable pieces of work (e.g. multiple API
  endpoints or features), call that out explicitly so it can be broken into
  tasks later.
Do not write or edit any code — this stage only produces the proposal text.

Scope: design exactly what the spec asks — no adjacent improvements, refactors
or extra features.

Decide every technical matter yourself — layout, names, libraries, API shapes,
where code goes — from the spec, the code and the project index; never ask about
those. Ask only about a BUSINESS decision the spec leaves open that changes what
gets built (who may do something, a rule, limit, price or status flow, what a
screen must show) and that neither the spec nor the code answers. Then do not
guess: end the proposal with a section headed exactly "${BUSINESS_QUESTIONS_HEADING}",
one "- " line per question. The run stops there until a person answers. Leave
the section out when there is nothing to ask — that is the usual case.

${FEATURE_TEST_POLICY}

The rules below govern the code this design will lead to. Plan for them now, so the
coding stage does not have to retrofit them:

${CODE_QUALITY_RULES}`;

/**
 * A schema file shapes the design, so its content goes in. A connection does
 * not: its credentials never reach a prompt, only `spec.database` (engine,
 * host, scripts folder) does, through `databasePromptSection`.
 */
function dbContext(spec: SpecInput): string[] {
  if (spec.dbInfo?.kind !== "schema-file") return databasePromptSection(spec.database, "design");
  return ["", "--- Database schema file ---", spec.dbInfo.value];
}

export async function runSpecsArch(
  spec: SpecInput,
  priorProposal: string | null,
  reviewerFeedback: string | undefined,
  inventory?: ReferenceInventory | null,
  projectContext?: ProjectContext | null,
): Promise<string> {
  // Read-only stage: the directory list is enough here, no write guard needed.
  const referenceDirs = referenceDirectories(spec.referencePaths);
  const roots = rootsOf(spec);
  const extraDirs = withSkillDirs(extraDirectories(spec.referencePaths, roots), spec.skillCatalog);

  const options: Options = {
    systemPrompt: SYSTEM_PROMPT,
    allowedTools: ["Read", "Glob", "Grep"],
    // A second tree to read needs more room than a single project does.
    ...stageOptions(referenceDirs.length ? "specsArchWithReference" : "specsArch"),
  };

  if (extraDirs.length) options.additionalDirectories = extraDirs;
  withIndexAccess(options, spec.projectIndexes);

  const parts = [
    "--- Spec ---",
    spec.specMarkdown,
    ...targetRootsPromptSection(roots),
    ...dbContext(spec),
    ...referencePromptSection(spec.referencePaths, inventory),
    ...indexPromptSection(spec.projectIndexes),
    ...projectContextPromptSection(projectContext),
    ...projectMemoryPromptSection(spec.projectMemory),
    ...metadataStandardsPromptSection(spec.metadataStandards, "design"),
    ...skillCatalogPromptSection(spec.skillCatalog),
  ];

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
    throw new StageError(`specs-arch stage failed: ${result.error ?? "empty response"}`);
  }
  return result.text;
}
