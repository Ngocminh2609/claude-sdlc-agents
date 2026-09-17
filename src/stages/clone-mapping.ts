import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { runStructuredQuery } from "../sdk-helpers.js";
import { config } from "../config.js";
import { referenceDirectories } from "../reference-repos.js";
import type {
  CloneInput,
  CloneMapping,
  ReferenceInventory,
  TargetConventions,
} from "../types.js";

/**
 * Decides, once, where every source file lands in the target and what has to
 * be renamed on the way.
 *
 * This exists because each port task runs in its own session. Without one
 * mapping agreed up front, the agent porting the API and the agent porting the
 * screen each pick their own package name and their own module, and the result
 * compiles in two different shapes. The pipeline pays for one extra call here
 * to stop paying for that.
 *
 * It is also the artifact a human can actually check. A design proposal is
 * prose you have to read closely; this is a table where a wrong row is visible
 * at a glance — and the coverage check afterwards measures the delivered files
 * against it.
 */

const SYSTEM_PROMPT = `You are the Clone Mapping agent in an automated port pipeline.
You are given: the files to port from a READ-ONLY reference repository, and a
description of how the target project is organised. Decide where each file goes
in the target and what must change in it.

For every source file produce one entry:
- source: path relative to the reference repository root.
- target: path relative to the TARGET project root, following the target's own
  layout, package/namespace root and naming conventions — never the reference's.
- group: the port unit this file belongs to, so related files are written
  together. Use a short stable label such as "SQL", "BE:category",
  "FE:occupations". Files that must agree with each other belong in one group.
- changes: what has to be rewritten in this file — package or namespace
  declaration, import substitutions, base classes or shared utilities that are
  named differently in the target, table or column prefixes, route paths.
  Be specific: give the actual old and new values, not "adjust imports".
- uncertain: true when you could not find a clear target-side equivalent, or the
  placement is a judgement call. Set it rather than guessing silently.

Rules:
- Every source file you were given gets an entry. If one should NOT be ported,
  still list it, mark uncertain, and say why in changes.
- Never target a path inside the reference repository.
- Order the entries so that what other files depend on comes first — database,
  then server, then client.
- In notes, record cross-cutting decisions: the package root you chose, the
  module you placed server code in and why, anything the target lacks that the
  port will need.`;

const MAPPING_SCHEMA = {
  type: "object",
  properties: {
    entries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          source: { type: "string" },
          target: { type: "string" },
          group: { type: "string" },
          changes: { type: "string" },
          uncertain: { type: "boolean" },
        },
        required: ["source", "target", "group", "changes"],
      },
    },
    notes: { type: "string" },
  },
  required: ["entries", "notes"],
};

export async function mapCloneTargets(
  clone: CloneInput,
  inventory: ReferenceInventory,
  conventions: TargetConventions | null,
): Promise<CloneMapping | null> {
  const options: Options = {
    systemPrompt: SYSTEM_PROMPT,
    allowedTools: ["Read", "Glob", "Grep"],
    additionalDirectories: referenceDirectories(clone.referencePaths),
    model: config.model,
    maxTurns: config.maxTurns.cloneMapping,
  };

  const prompt = [
    "--- What is being cloned ---",
    clone.what,
    "",
    "--- Reference repositories (READ-ONLY) ---",
    ...referenceDirectories(clone.referencePaths),
    "",
    "--- Source files to place ---",
    ...inventory.files.map((file) => `- ${file.path} — ${file.role}`),
    ...(inventory.notes.trim() ? ["", `Inventory notes: ${inventory.notes.trim()}`] : []),
    "",
    "--- How the target project is organised ---",
    conventions?.summary ??
      "(Not available — read the target project yourself before deciding any path.)",
  ].join("\n");

  const result = await runStructuredQuery<CloneMapping>(prompt, options, MAPPING_SCHEMA);
  if (!result.ok || !result.data?.entries.length) return null;
  return result.data;
}
