import path from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { runStructuredQuery } from "../sdk-helpers.js";
import { config, networkExfilBashBlocklist } from "../config.js";
import { CODE_QUALITY_RULES } from "../prompts/code-quality.js";
import { metadataStandardsPromptSection } from "../metadata-standards.js";
import { runtimePortsPromptSection } from "../prompts/runtime-ports.js";
import { StageError } from "../stage-error.js";
import { extraDirectories, referenceDirectories } from "../reference-repos.js";
import {
  isSplit,
  referenceRootsPromptSection,
  rootPath,
  rootsOf,
  targetRootsPromptSection,
  type ProjectRoot,
} from "../target-roots.js";
import { indexPromptSection, withIndexAccess } from "../project-index.js";
import { isTestFile } from "../test-files.js";
import { guardReferenceRepos } from "./coding.js";
import type {
  CloneInput,
  CloneLayer,
  CloneMapping,
  CloneMappingEntry,
  ClonePortResult,
  TargetConventions,
} from "../types.js";

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

An entry whose source is "(new)" has no source file: write it from its changes
description (for example a schema script created from the entities this port
adds).

If you do not write a file at the exact target path the mapping gives, you must
declare it in "deviations" — a file that is neither written nor declared is
reported to the user as missing:
- kind "merged": its code went into another file you wrote, because the target's
  own conventions call for it (say which convention). Put that file in coveredBy,
  as a path relative to the same target folder.
- kind "not-needed": you judged it unnecessary. Explain why in reason. It is
  still reported as missing, so use it only for a file nothing else needs.
Your "summary" is the report of what you did, as before.

Never leave a reference to something that does not exist. Every import you
write must resolve to a file that is on disk when you finish — written by you,
by an earlier group, or already in the target — and every API call a client
file makes must hit an endpoint the server side actually maps.

Files the target normally generates with its own tool (an OpenAPI client from
\`max openapi\` / \`openapi-generator\`, a code generator that needs the server
running) are NOT an exception: write them by hand now, in exactly the shape the
generator emits — the same folder, the file name the generator would derive
(e.g. from the controller's @Tag), the function names it would derive (e.g. the
controller method names / operationIds), the same request helper and URL
prefix, and the types it would add (extend the existing generated typings file
if the target keeps one). Read an existing generated file in the target and
copy its shape. The feature must work before anyone runs the generator; running
it later only rewrites the file with the same content. Say in your summary that
the file is normally generated and which command regenerates it.

Never create, edit or delete anything inside a reference repository. Every file
you write goes into the target project (the current working directory).

The rules below apply to what you write, with one exception: where the source
file and the target project's conventions disagree on formatting, follow the
TARGET project.

${CODE_QUALITY_RULES}`;

const PORT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    deviations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          target: { type: "string" },
          kind: { type: "string", enum: ["merged", "not-needed"] },
          coveredBy: { type: "string" },
          reason: { type: "string" },
        },
        required: ["target", "kind", "reason"],
      },
    },
  },
  required: ["summary", "deviations"],
};

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
  /**
   * Client groups only: the routes the server code already on disk maps, read
   * from it — the API the client must be written against.
   */
  serverApi?: string[];
}

const MAX_SUMMARY_CHARS = 1200;

export async function portCloneGroup(request: ClonePortRequest): Promise<ClonePortResult> {
  const { clone, mapping, conventions, group, completedGroups, runtimePorts = [], serverApi } = request;
  const entries = mapping.entries.filter((entry) => entry.group === group);
  const roots = rootsOf(clone);

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
    // References are readable only (the guard above); a second target folder
    // (FE when BE is the working directory) is readable and writable.
    additionalDirectories: extraDirectories(clone.referencePaths, roots),
    systemPrompt: SYSTEM_PROMPT,
    model: config.model,
    maxTurns: config.maxTurns.clonePort,
  };
  withIndexAccess(options, clone.projectIndexes);

  const parts = [
    "--- What is being cloned ---",
    clone.what,
    "",
    "--- Reference repositories (READ-ONLY) ---",
    ...referenceDirectories(clone.referencePaths),
    ...referenceRootsPromptSection(clone.referenceRoots ?? []),
    ...targetRootsPromptSection(roots),
    ...indexPromptSection(clone.projectIndexes),
    "",
    "--- How the target project is organised ---",
    conventions?.summary ?? "(Not available — follow the mapping and the code already in the target.)",
    "",
    `--- Your group: ${group} ---`,
    ...entries.map((entry) => describeEntry(entry, roots)),
    "",
    "--- The full mapping, for context on what other groups are producing ---",
    ...mapping.entries.map(
      (entry) => `- [${entry.group}] ${entry.source} -> ${destination(entry, roots)}`,
    ),
    ...(mapping.notes.trim() ? ["", `Mapping notes: ${mapping.notes.trim()}`] : []),
    ...metadataStandardsPromptSection(clone.metadataStandards, "port"),
  ];

  if (completedGroups.length) {
    parts.push("", "--- Groups already ported in this run ---");
    for (const done of completedGroups) {
      parts.push(`- ${done.group}: ${truncate(done.summary)}`);
    }
  }

  if (serverApi) {
    parts.push(
      "",
      "--- The server API this client must call (read from the server code already written) ---",
      ...(serverApi.length
        ? serverApi
        : ["(No routes could be read from the ported server files — read the server code yourself before writing any call.)"]),
      "",
      "Call exactly these methods and paths, through the target's own request helper and URL prefix.",
      "Before writing a client function, open its controller and the request/response DTO classes it",
      "uses, and use their exact field names and types. Do not call any route that is not listed here",
      "or already in the target, and do not copy the reference project's routes if they differ.",
    );
  }

  parts.push(...runtimePortsPromptSection(runtimePorts));

  const result = await runStructuredQuery<ClonePortResult>(parts.join("\n"), options, PORT_SCHEMA);
  if (!result.ok || !result.data) {
    throw new StageError(`clone port failed on group ${group}: ${result.error ?? "unknown error"}`);
  }
  // Only deviations for this group's own files count — a claim about another
  // group's file is not this agent's to make.
  const ownTargets = new Set(entries.map((entry) => entry.target));
  return {
    summary: result.data.summary ?? "",
    deviations: (result.data.deviations ?? []).filter((deviation) => ownTargets.has(deviation.target)),
  };
}

const FIX_PROMPT = `You are the Clone Fix agent in an automated port pipeline.
A feature was ported into the target project, and the checks after the port
failed: the build, the unit tests, or both. Fix the PORTED CODE so they pass.

- Read each failure, find its cause in the ported files, and fix it there. Keep
  the fix minimal and consistent with the target's conventions and the rest of
  the ported feature (the server and client must still agree on every route and
  field).
- You cannot edit test files. A failing test is the specification of the bug; if
  you are convinced a test itself is wrong, say so in your summary with the
  reason, and leave it.
- Fix only what the failures point at. Errors that are plainly pre-existing and
  outside the ported files are not yours to fix — say you left them.
- Do not run the full test suite or start the application; the pipeline re-runs
  the checks after you. You may compile to check a fix.

Never create, edit or delete anything inside a reference repository.

${CODE_QUALITY_RULES}`;

export interface CloneFixRequest {
  clone: CloneInput;
  mapping: CloneMapping;
  conventions: TargetConventions | null;
  /** Build errors and failing tests, verbatim. */
  failures: string[];
  serverApi: string[];
  round: number;
}

/**
 * One fix round after the build or the unit tests failed. It may write any
 * file in the target except test files — the tests are what judge the fix.
 */
export async function fixCloneFailures(request: CloneFixRequest): Promise<string> {
  const { clone, mapping, conventions, failures, serverApi, round } = request;
  const roots = rootsOf(clone);
  const referenceGuard = guardReferenceRepos(clone.referencePaths);

  const options: Options = {
    allowedTools: ["Read", "Glob", "Grep", "Bash"],
    disallowedTools: [
      "Bash(git commit*)",
      "Bash(git push*)",
      "Bash(git branch*)",
      "Bash(git checkout*)",
      "Bash(git stash*)",
      ...networkExfilBashBlocklist,
    ],
    canUseTool: async (toolName, input, context) => {
      if (toolName === "Write" || toolName === "Edit") {
        const filePath = String((input as { file_path?: string }).file_path ?? "");
        if (isTestFile(filePath)) {
          return { behavior: "deny", message: "Test files cannot be changed in the fix stage — fix the code under test." };
        }
      }
      return referenceGuard(toolName, input, context);
    },
    additionalDirectories: extraDirectories(clone.referencePaths, roots),
    systemPrompt: FIX_PROMPT,
    model: config.model,
    maxTurns: config.maxTurns.cloneFix,
  };
  withIndexAccess(options, clone.projectIndexes);

  const prompt = [
    `--- Fix round ${round} ---`,
    "",
    "--- What was ported ---",
    clone.what,
    ...targetRootsPromptSection(roots),
    ...indexPromptSection(clone.projectIndexes),
    "",
    "--- How the target project is organised ---",
    conventions?.summary ?? "(Not available — follow the code already in the target.)",
    "",
    "--- Ported files ---",
    ...mapping.entries.map((entry) => `- [${layerOf(entry)}] ${destination(entry, roots)}`),
    "",
    "--- Server routes the ported code maps ---",
    ...(serverApi.length ? serverApi : ["(none could be read)"]),
    "",
    ...metadataStandardsPromptSection(clone.metadataStandards, "fix"),
    "",
    "--- Failures to fix ---",
    ...failures.map((failure) => `- ${failure}`),
  ].join("\n");

  const result = await runStructuredQuery<{ summary: string }>(prompt, options, {
    type: "object",
    properties: { summary: { type: "string" } },
    required: ["summary"],
  });
  if (!result.ok || !result.data) {
    throw new StageError(`clone fix round ${round} failed: ${result.error ?? "unknown error"}`);
  }
  return result.data.summary ?? "";
}

function describeEntry(entry: CloneMappingEntry, roots: ProjectRoot[]): string {
  const flag = entry.uncertain ? " [UNCERTAIN]" : "";
  return `- ${entry.source}\n    -> ${destination(entry, roots)}${flag}\n    changes: ${entry.changes}`;
}

/**
 * Where the file is written, as an absolute path: with separate BE/FE folders
 * a relative target alone does not say which folder it is relative to, and a
 * file written under the wrong one would pass nothing downstream.
 */
function destination(entry: CloneMappingEntry, roots: ProjectRoot[]): string {
  return isSplit(roots) ? path.resolve(rootPath(roots, entry.root), entry.target) : entry.target;
}

function truncate(summary: string): string {
  const text = summary.trim();
  return text.length <= MAX_SUMMARY_CHARS ? text : `${text.slice(0, MAX_SUMMARY_CHARS)}… (truncated)`;
}

const LAYER_RANK: Record<CloneLayer, number> = { db: 0, be: 1, fe: 2 };

/**
 * Groups in port order: every database group, then every server group, then
 * every client group — enforced here rather than trusted to the mapping's
 * listing order, because the client is written against the server code that
 * already exists on disk. Within a layer, the mapping's own order stands.
 */
export function portGroups(mapping: CloneMapping): string[] {
  const rank = new Map<string, number>();
  const order: string[] = [];
  for (const entry of mapping.entries) {
    const layer = LAYER_RANK[layerOf(entry)];
    if (!rank.has(entry.group)) order.push(entry.group);
    rank.set(entry.group, Math.min(rank.get(entry.group) ?? layer, layer));
  }
  return order
    .map((group, index) => ({ group, index, rank: rank.get(group) ?? 1 }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((item) => item.group);
}

/** A group's layer: the earliest layer among its files. */
export function groupLayer(mapping: CloneMapping, group: string): CloneLayer {
  const layers = mapping.entries.filter((entry) => entry.group === group).map(layerOf);
  return layers.reduce<CloneLayer>((lowest, layer) => (LAYER_RANK[layer] < LAYER_RANK[lowest] ? layer : lowest), "fe");
}

/** The entry's layer, inferred from its path when the mapping did not say. */
export function layerOf(entry: CloneMappingEntry): CloneLayer {
  if (entry.layer) return entry.layer;
  const target = entry.target.toLowerCase();
  if (target.endsWith(".sql") || /(^|\/)(db|migrations?|flyway|liquibase)\//.test(target)) return "db";
  if (entry.root === "fe") return "fe";
  if (entry.root === "be") return "be";
  if (/\.(tsx?|jsx?|vue|less|s?css)$/.test(target)) return "fe";
  return "be";
}
