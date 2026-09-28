import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { ProjectRoot } from "./target-roots.js";

/**
 * Opt-in statistical-metadata standards (DDI-L 3.3, GSIM 2.0, GSBPM, SDC,
 * object-level ACL) for the stages that design, review and write code.
 *
 * A target opts in by committing `.metadata-standards.yml` at a target folder
 * root. Without that file nothing is added to any prompt, so every other repo
 * runs exactly as before — the standards are a per-project decision, never a
 * default of this tool.
 *
 * Only the guideline sections for the enabled modules are sent. The document is
 * long, and every stage pays for its prompt on every call; a module the project
 * did not choose is text the agent would have to be told to ignore anyway.
 */

export const METADATA_STANDARDS_FILE = ".metadata-standards.yml";

/** Bundled with the tool; resolves from both `src/` (tsx) and `dist/` (built). */
export const GUIDELINE_PATH = fileURLToPath(new URL("../docs/metadata-standards-ai-guidelines.md", import.meta.url));

export const METADATA_MODULES = ["CORE", "DDI", "GSIM", "CLS", "GSBPM", "SDC", "AUTHZ", "NSO"] as const;
export type MetadataModule = (typeof METADATA_MODULES)[number];

/** Guideline section number (`## §N.`) holding each module's rules. */
const MODULE_SECTION: Record<MetadataModule, number> = {
  CORE: 4,
  DDI: 5,
  GSIM: 6,
  CLS: 7,
  GSBPM: 8,
  SDC: 9,
  AUTHZ: 10,
  NSO: 11,
};

/**
 * Sent whatever the modules: labels (§0), decisions and their defaults (§2),
 * shared vocabulary (§3). Left out on purpose, because every stage call pays
 * for them: §1 tells an interactive agent to ask the user (the config already
 * answered), §12 is the interactive gap-report workflow, and §13 is a human PR
 * checklist that only restates rules already sent.
 */
const ALWAYS_SECTIONS = [0, 2, 3];

export type StandardsMode = "strict" | "advisory";

export interface MetadataStandards {
  /** The config file the standards came from. */
  configPath: string;
  mode: StandardsMode;
  modules: MetadataModule[];
  /** The config file verbatim: decisions, agency, stack and waivers reach the agent as written. */
  configText: string;
  /** The guideline excerpt for `modules`. */
  rules: string;
}

/**
 * Reads the standards config from the target folders. Separate BE/FE folders
 * may each carry the file; they must then agree, because one run cannot follow
 * two rule sets. Throws on a malformed config — before any stage is paid for.
 */
export function loadMetadataStandards(
  roots: ProjectRoot[],
  guidelinePath: string = GUIDELINE_PATH,
): MetadataStandards | null {
  const found = roots
    .map((root) => path.join(root.path, METADATA_STANDARDS_FILE))
    .filter((file) => existsSync(file))
    .map((file) => ({ file, text: readFileSync(file, "utf-8") }));
  if (!found.length) return null;

  const [first] = found;
  const conflicting = found.find((entry) => entry.text.trim() !== first.text.trim());
  if (conflicting) {
    throw new Error(
      `${METADATA_STANDARDS_FILE} differs between ${first.file} and ${conflicting.file}. Make them identical or keep only one.`,
    );
  }

  const { mode, modules } = parseConfig(first.text, first.file);
  if (!modules.length) return null;

  return {
    configPath: first.file,
    mode,
    modules,
    configText: first.text.trim(),
    rules: guidelineExcerpt(readFileSync(guidelinePath, "utf-8"), modules),
  };
}

function parseConfig(text: string, file: string): { mode: StandardsMode; modules: MetadataModule[] } {
  let data: unknown;
  try {
    data = parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid YAML: ${(error as Error).message}`);
  }
  const config = (data ?? {}) as { mode?: unknown; modules?: unknown };

  const mode = config.mode ?? "strict";
  if (mode !== "strict" && mode !== "advisory") {
    throw new Error(`${file}: mode must be "strict" or "advisory", got ${JSON.stringify(mode)}.`);
  }

  // "none" is the documented way to opt a repo out explicitly.
  if (config.modules === undefined || config.modules === null || config.modules === "none") {
    return { mode, modules: [] };
  }
  if (!Array.isArray(config.modules)) {
    throw new Error(`${file}: modules must be a list, e.g. [CORE, DDI].`);
  }
  const modules = config.modules.map((name) => String(name).trim().toUpperCase());
  const unknown = modules.filter((name) => !(METADATA_MODULES as readonly string[]).includes(name));
  if (unknown.length) {
    throw new Error(`${file}: unknown module(s) ${unknown.join(", ")}. Known: ${METADATA_MODULES.join(", ")}.`);
  }
  return { mode, modules: [...new Set(modules)] as MetadataModule[] };
}

/** The always-sent sections plus each enabled module's section, in document order. */
export function guidelineExcerpt(guideline: string, modules: MetadataModule[]): string {
  const sections = splitSections(guideline);
  const wanted = [...new Set([...ALWAYS_SECTIONS, ...modules.map((module) => MODULE_SECTION[module])])].sort(
    (a, b) => a - b,
  );
  return wanted
    .map((number) => {
      const section = sections.get(number);
      // The section numbers are this file's contract with the guideline; a
      // renumbered document must fail loudly, not send the wrong rules.
      if (!section) throw new Error(`Guideline has no section §${number} — ${GUIDELINE_PATH} was restructured.`);
      return section;
    })
    .join("\n\n");
}

function splitSections(guideline: string): Map<number, string> {
  const sections = new Map<number, string>();
  const headings = [...guideline.matchAll(/^## §(\d+)\./gm)];
  headings.forEach((heading, index) => {
    const end = index + 1 < headings.length ? headings[index + 1].index : guideline.length;
    const body = guideline.slice(heading.index, end).replace(/\n---\s*$/, "").trim();
    sections.set(Number(heading[1]), body);
  });
  return sections;
}

/** One progress line, printed whether or not the standards apply, so a run never looks ruled when it is not. */
export function describeMetadataStandards(standards: MetadataStandards | null | undefined): string {
  if (!standards) return `Metadata standards: not applied (no ${METADATA_STANDARDS_FILE} with modules in the target).`;
  return `Metadata standards: ${standards.modules.join(", ")} (${standards.mode}) from ${standards.configPath}`;
}

/**
 * `--no-metadata-standards` (UI: the "Áp dụng metadata standards" selectbox
 * set to "Không") skips `.metadata-standards.yml` entirely for this one run,
 * even when the target commits one — an explicit, per-run override, not a
 * second way to opt in. `loadMetadataStandards` itself stays unaware of this;
 * the override lives here, one call site up, so every other caller of that
 * function (tests, a future stage) still sees the file honestly.
 */
export function metadataStandardsFor(
  targetRoots: ProjectRoot[],
  disabled: boolean,
  guidelinePath: string = GUIDELINE_PATH,
): MetadataStandards | null {
  return disabled ? null : loadMetadataStandards(targetRoots, guidelinePath);
}

/** The progress line `describeMetadataStandards` alone can't tell apart: skipped by request, vs. no file to begin with. */
export function describeMetadataStandardsOverride(disabled: boolean): string[] {
  return disabled
    ? ["Metadata standards: skipped for this run (--no-metadata-standards), ignoring any .metadata-standards.yml"]
    : [];
}

/** What the stage does with code — each needs a different reading of the same rules. */
export type StandardsUse = "design" | "review" | "code" | "port" | "fix";

const INSTRUCTIONS: Record<StandardsUse, Record<StandardsMode, string>> = {
  design: {
    strict:
      "Design so every enabled MUST rule holds for the code this work adds or changes, and name the rule IDs the design relies on. A MUST rule the design cannot meet goes in the proposal as a deviation with its reason — never drop one silently.",
    advisory:
      "Apply the rules to the code this work adds. Do not plan refactors of existing code to meet them; list existing violations you notice as out-of-scope notes, with rule IDs.",
  },
  review: {
    strict:
      "A design that breaks an enabled MUST rule without declaring it as a deviation is not sound: add an amendment when the fix is small and exact, otherwise reject, citing the rule ID. Rules waived in the config are accepted.",
    advisory:
      "Raise a violation only when it concerns code the design adds, and only as an amendment. Never reject over existing code.",
  },
  code: {
    strict:
      "Code you write or change must satisfy every enabled MUST rule, and the SHOULD rules unless the approved design says otherwise. If a MUST rule cannot be met, say so in your summary with the rule ID.",
    advisory:
      "Follow the rules in the code you write. Do not refactor existing code to meet them; report violations you noticed in your summary, with rule IDs.",
  },
  // The port contract (identical behaviour, no improvements) wins in both modes:
  // restructuring a port toward the standards is a separate, reviewable change.
  port: {
    strict:
      "The port rules above still win: do not restructure ported logic to meet these standards. Apply them to files written from a \"(new)\" entry and to target-side adjustments only. List every violation you noticed in the ported code in your summary, with rule IDs, so a person can plan the follow-up.",
    advisory:
      "The port rules above still win: do not restructure ported logic to meet these standards. List every violation you noticed in the ported code in your summary, with rule IDs.",
  },
  fix: {
    strict:
      "Keep every fix within the enabled MUST rules. Do not use a fix round to refactor toward the standards.",
    advisory: "Do not use a fix round to refactor toward the standards.",
  },
};

/**
 * Prompt block for one stage. Empty when the target did not opt in.
 *
 * Code samples go only to the Coding stage: designing, reviewing, porting and
 * fixing need the rules, not an implementation to copy, and the samples are a
 * fifth of the excerpt that every one of those calls would otherwise pay for.
 */
export function metadataStandardsPromptSection(
  standards: MetadataStandards | null | undefined,
  use: StandardsUse,
): string[] {
  if (!standards) return [];
  const rules = use === "code" ? standards.rules : withoutCodeSamples(standards.rules);
  return [
    "",
    `--- Metadata standards for this project (${standards.mode}; modules: ${standards.modules.join(", ")}) ---`,
    "The project chose these standards in its config file; do not ask about them. Rule IDs such as CORE-04",
    "refer to the guideline excerpt below, and the config's decisions override the defaults in §2.2.",
    INSTRUCTIONS[use][standards.mode],
    "",
    `Config (${standards.configPath}):`,
    standards.configText,
    "",
    "Guideline excerpt:",
    rules,
  ];
}

function withoutCodeSamples(rules: string): string {
  return rules.replace(/\n```[\s\S]*?\n```\n?/g, "\n").replace(/\n{3,}/g, "\n\n");
}

/** What a saved plan depends on: the chosen standards and the rule text itself. */
export function metadataStandardsFingerprint(standards: MetadataStandards | null | undefined): string[] | null {
  return standards ? [standards.configText, standards.rules] : null;
}
