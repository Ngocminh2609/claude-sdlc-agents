import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { runTextQuery } from "../sdk-helpers.js";
import { config } from "../config.js";
import { indexPromptSection, withIndexAccess } from "../project-index.js";
import { StageError } from "../stage-error.js";
import { extraDirectories, referencePromptSection } from "../reference-repos.js";
import { skillCatalogPromptSection, withSkillDirs } from "../skills-catalog.js";
import { rootsOf, targetRootsPromptSection } from "../target-roots.js";
import type { SpecInput } from "../types.js";

/**
 * What the Spec Draft stage works from: a plain-language request instead of a
 * finished spec, plus the same target/reference/index/skill context the design
 * stage gets, so the draft names the project's real modules and screens.
 */
export type SpecDraftInput = Omit<SpecInput, "specMarkdown" | "dbInfo"> & { request: string };

const SYSTEM_PROMPT = `You are the Spec Draft agent in an automated SDLC pipeline.
A person describes what they want in plain words. Turn that request into a spec
document that the rest of the pipeline (design → tasks → code → browser E2E) can
implement and verify. A person will read and correct your draft before anything
is built, so be explicit about what you assumed.

Read the existing project (current working directory) first, so the spec names
the real modules, screens, endpoints and tables it touches instead of inventing
them. Do not write or edit any file — this stage only produces the spec text.

Write the spec in the language of the request (a Vietnamese request gets a
Vietnamese spec), as Markdown, with exactly these sections in this order:

# <Feature name>

## Bối cảnh
Which screen/API/module this belongs to and what already exists that relates to
it — cite the real paths you found.

## Yêu cầu
Bullet list of required behaviour, each one observable from outside (what the
user sees or what the API returns), not how to implement it.

## Ràng buộc
Project conventions the work must follow (naming, layering, shared components,
libraries) — only ones you actually saw in the code, with a path as evidence.

## Tiêu chí nghiệm thu
Checkbox list ("- [ ] ...") of acceptance criteria. Each one must be checkable
by operating the running app in a browser: "click X, then Y is shown", "enter an
invalid Z, the message W appears". "Clean code" or "fast" are not checkable.
Cover the main flow and the obvious error cases from the request.

## Câu hỏi mở
Everything the request leaves undecided that changes what gets built. Ask; do
not answer it yourself. Write "Không có" when there are none.

Rules:
- Stay at the level of behaviour and scope. The design (files, classes, API
  shapes) is the next stage's job — do not do it here.
- Do not add features the request did not ask for. If something is plausibly
  needed but not requested, put it under "Câu hỏi mở", not under "Yêu cầu".
- Anything you inferred rather than read in the request or the code is marked
  "(giả định)" inline, so the reviewer can find and check it.
- Output only the spec Markdown, starting with the "# " title line. No preamble,
  no closing remarks, no code fence around the whole document.`;

/**
 * Removes a single code fence wrapped around the whole answer. The prompt asks
 * for bare Markdown, but a model that fences it anyway would otherwise save a
 * spec whose first line is "```markdown".
 */
export function unwrapSpecMarkdown(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  return `${(fenced ? fenced[1] : trimmed).trim()}\n`;
}

export async function runSpecDraft(input: SpecDraftInput): Promise<string> {
  // Read-only stage: the directory list is enough here, no write guard needed.
  const roots = rootsOf(input);
  const extraDirs = withSkillDirs(extraDirectories(input.referencePaths, roots), input.skillCatalog);

  const options: Options = {
    systemPrompt: SYSTEM_PROMPT,
    allowedTools: ["Read", "Glob", "Grep"],
    model: config.model,
    maxTurns: config.maxTurns.specDraft,
  };

  if (extraDirs.length) options.additionalDirectories = extraDirs;
  withIndexAccess(options, input.projectIndexes);

  const prompt = [
    "--- Request ---",
    input.request,
    ...targetRootsPromptSection(roots),
    ...referencePromptSection(input.referencePaths),
    ...indexPromptSection(input.projectIndexes),
    ...skillCatalogPromptSection(input.skillCatalog),
  ].join("\n");

  const result = await runTextQuery(prompt, options);
  if (!result.ok || !result.text?.trim()) {
    throw new StageError(`spec-draft stage failed: ${result.error ?? "empty response"}`);
  }
  return unwrapSpecMarkdown(result.text);
}
