import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { runStructuredQuery } from "../sdk-helpers.js";
import { config } from "../config.js";
import { indexPromptSection, withIndexAccess } from "../project-index.js";
import { extraDirectories, referenceDirectories } from "../reference-repos.js";
import { referenceRootsPromptSection, rootsOf, targetRootsPromptSection } from "../target-roots.js";
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
- target: path relative to the TARGET folder the file goes into, following the
  target's own layout, package/namespace root and naming conventions — never the
  reference's.
- root: when the target has separate folders, which one the file goes into —
  "be" for server code and database scripts, "fe" for client code. Omit it when
  the target is a single project folder.
- layer: "db" for database scripts, "be" for server code (including its
  configuration and build files), "fe" for client code. The pipeline ports every
  db group first, then every be group, then every fe group, and writes the client
  against the server routes it finds on disk — so the layer must be right.
- group: the port unit this file belongs to, so related files are written
  together. Use a short stable label such as "SQL", "BE:category",
  "FE:occupations". Files that must agree with each other belong in one group,
  and a group never mixes layers.
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
- Database scripts come first and are required: if the target creates its tables
  only with scripts (ddl-auto none/validate, or a migration tool — see the
  conventions) and the source files include no script for a table that a ported
  entity maps to, add an entry for that script anyway (layer "db"): source "(new)", target the script path following the
  target's own naming and folder (next to its existing schema scripts), group the
  database group, and changes listing every table, column, type, key and index to
  create, taken from the ported entities. Without it the ported code compiles but
  fails at runtime on tables that do not exist.
- Generated files: if the target normally generates a kind of file with its own
  tool (an OpenAPI client, a code generator), still map an entry for every such
  file the ported client code will import — target it at the exact path, file
  name and function names the generator would produce (e.g. the file name from
  the controller's @Tag, the function names from its method names), and say in
  changes that the port writes it by hand in the generator's shape and which
  command regenerates it. Ported client code must never import a file that no
  entry creates and that does not already exist.
- Wiring: every client-side API call must have a server-side endpoint. When the
  ported client calls an endpoint, make sure an entry ports (or the target
  already has) the controller that maps that path.
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
          root: { type: "string", enum: ["be", "fe", "app"] },
          layer: { type: "string", enum: ["db", "be", "fe"] },
          group: { type: "string" },
          changes: { type: "string" },
          uncertain: { type: "boolean" },
        },
        required: ["source", "target", "layer", "group", "changes"],
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
  const roots = rootsOf(clone);
  const options: Options = {
    systemPrompt: SYSTEM_PROMPT,
    allowedTools: ["Read", "Glob", "Grep"],
    // The reference repos, and a second target folder when BE and FE are split
    // — the mapping has to see where each side's files already live.
    additionalDirectories: extraDirectories(clone.referencePaths, roots),
    model: config.model,
    maxTurns: config.maxTurns.cloneMapping,
  };
  withIndexAccess(options, clone.projectIndexes);

  const prompt = [
    "--- What is being cloned ---",
    clone.what,
    "",
    "--- Reference repositories (READ-ONLY) ---",
    ...referenceDirectories(clone.referencePaths),
    ...referenceRootsPromptSection(clone.referenceRoots ?? []),
    ...targetRootsPromptSection(roots),
    ...indexPromptSection(clone.projectIndexes),
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
