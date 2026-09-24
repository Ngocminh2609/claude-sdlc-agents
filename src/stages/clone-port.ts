import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { runTextQuery } from "../sdk-helpers.js";
import { config, networkExfilBashBlocklist } from "../config.js";
import { CODE_QUALITY_RULES } from "../prompts/code-quality.js";
import { runtimePortsPromptSection } from "../prompts/runtime-ports.js";
import { StageError } from "../stage-error.js";
import { referenceDirectories } from "../reference-repos.js";
import { guardReferenceRepos } from "./coding.js";
import type { CloneInput, CloneMapping, CloneMappingEntry, TargetConventions } from "../types.js";

/**
 * Writes one group of the mapping into the target project.
 *
 * Separate from the Coding stage because the job is different: there is no
 * design to interpret and nothing to invent — the source file is the
 * specification, and the mapping already said where it goes and what to
 * rename. The failure mode to guard against here is improvisation, not
 * under-specification, so the prompt spends its words forbidding that.
 *
 * It reuses the Coding stage's reference-repo write guard rather than
 * reimplementing it: the rule is the same one (references are readable, never
 * writable) and two copies of a security check drift.
 */

const SYSTEM_PROMPT = `You are the Clone Port agent in an automated port pipeline.
You port files from a READ-ONLY reference repository into the target project,
following a mapping that has already been decided. You are not designing
anything and not improving anything.

For each file in your assigned group:
1. Read the source file in the reference repository.
2. Write it to the target path the mapping gives, applying exactly the changes
   the mapping lists — package/namespace, imports, base classes, table and
   column names, route paths.
3. Keep the behaviour identical. Do not rename methods, restructure logic,
   "modernise" the code, add features, or drop code you think is unused. If the
   source has a quirk, port the quirk.
4. Fix up what the target requires to accept the file: register a module with
   the build, add a route, add a dependency the target genuinely lacks. Keep
   these adjustments minimal and say what you did.

Where the mapping marked an entry uncertain, port it as best you can and state
the doubt plainly in your summary — do not quietly skip it, and do not invent a
target-side equivalent that does not exist.

Never create, edit or delete anything inside a reference repository. Every file
you write goes into the target project (the current working directory).

The rules below apply to what you write, with one exception: where the source
file and the target project's conventions disagree on formatting, follow the
TARGET project.

${CODE_QUALITY_RULES}`;

export interface ClonePortRequest {
  clone: CloneInput;
  mapping: CloneMapping;
  conventions: TargetConventions | null;
  /** The group being ported now. */
  group: string;
  /** Groups already ported in this run, with what each reported. */
  completedGroups: { group: string; summary: string }[];
  /** Ports checked free just before this call, for any server the agent starts to check its work. */
  runtimePorts?: number[];
}

const MAX_SUMMARY_CHARS = 1200;

export async function portCloneGroup(request: ClonePortRequest): Promise<string> {
  const { clone, mapping, conventions, group, completedGroups, runtimePorts = [] } = request;
  const entries = mapping.entries.filter((entry) => entry.group === group);

  const options: Options = {
    // Write/Edit are gated by canUseTool — see guardReferenceRepos.
    allowedTools: ["Read", "Glob", "Grep", "Bash"],
    disallowedTools: [
      "Bash(git commit*)",
      "Bash(git push*)",
      "Bash(git branch*)",
      "Bash(git checkout*)",
      ...networkExfilBashBlocklist,
    ],
    canUseTool: guardReferenceRepos(clone.referencePaths),
    additionalDirectories: referenceDirectories(clone.referencePaths),
    systemPrompt: SYSTEM_PROMPT,
    model: config.model,
    maxTurns: config.maxTurns.clonePort,
  };

  const parts = [
    "--- What is being cloned ---",
    clone.what,
    "",
    "--- Reference repositories (READ-ONLY) ---",
    ...referenceDirectories(clone.referencePaths),
    "",
    "--- How the target project is organised ---",
    conventions?.summary ?? "(Not available — follow the mapping and the code already in the target.)",
    "",
    `--- Your group: ${group} ---`,
    ...entries.map(describeEntry),
    "",
    "--- The full mapping, for context on what other groups are producing ---",
    ...mapping.entries.map((entry) => `- [${entry.group}] ${entry.source} -> ${entry.target}`),
    ...(mapping.notes.trim() ? ["", `Mapping notes: ${mapping.notes.trim()}`] : []),
  ];

  if (completedGroups.length) {
    parts.push("", "--- Groups already ported in this run ---");
    for (const done of completedGroups) {
      parts.push(`- ${done.group}: ${truncate(done.summary)}`);
    }
  }

  parts.push(...runtimePortsPromptSection(runtimePorts));

  const result = await runTextQuery(parts.join("\n"), options);
  if (!result.ok) {
    throw new StageError(`clone port failed on group ${group}: ${result.error ?? "unknown error"}`);
  }
  return result.text ?? "";
}

function describeEntry(entry: CloneMappingEntry): string {
  const flag = entry.uncertain ? " [UNCERTAIN]" : "";
  return `- ${entry.source}\n    -> ${entry.target}${flag}\n    changes: ${entry.changes}`;
}

function truncate(summary: string): string {
  const text = summary.trim();
  return text.length <= MAX_SUMMARY_CHARS ? text : `${text.slice(0, MAX_SUMMARY_CHARS)}… (truncated)`;
}

/** Groups in the order the mapping lists them — DB before server before client. */
export function portGroups(mapping: CloneMapping): string[] {
  const seen = new Set<string>();
  const groups: string[] = [];
  for (const entry of mapping.entries) {
    if (seen.has(entry.group)) continue;
    seen.add(entry.group);
    groups.push(entry.group);
  }
  return groups;
}
