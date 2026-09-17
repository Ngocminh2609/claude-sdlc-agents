import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { runStructuredQuery } from "../sdk-helpers.js";
import { config } from "../config.js";
import { referenceDirectories } from "../reference-repos.js";
import type { ReferenceInventory, SpecInput } from "../types.js";

/**
 * Walks the reference repos once, before any design work, and writes down
 * every file the spec's work should copy from or follow.
 *
 * Why a stage of its own rather than leaving it to Specs & Arch: read access
 * to a reference repo is not the same as reading it. Each later stage is a
 * separate session with its own turn budget, and each would otherwise
 * rediscover the tree from scratch — on a real repo (node_modules, Maven
 * `target/`) that budget goes on walking directories instead of on the work.
 * Doing it once produces one explicit list that Specs & Arch, Task breakdown
 * and Coding all share, and that a human can diff against what actually got
 * written.
 *
 * It does not make "nothing was missed" a guarantee. It makes what the
 * pipeline believes it should copy visible and checkable, which is the honest
 * version of that.
 */

const SYSTEM_PROMPT = `You are the Reference Inventory agent in an automated SDLC pipeline.
One or more READ-ONLY reference repositories are available to you. Your only
job is to list the files in them that the spec's work should copy from,
adapt, or follow — before any design or code is written.

Be exhaustive about what is relevant, across every layer the spec touches
(database scripts, server code, client code, configuration, tests, resource
and translation files). A file a later stage never hears about is a file it
will not copy, so missing one here means it is missing from the result.

Be equally deliberate about what you leave out: skip dependency and build
output directories (node_modules, target, dist, build, .git, bin, obj) and
anything unrelated to the spec. Say in the notes what you excluded and why,
and flag anything you were unsure about rather than dropping it silently.

Use paths relative to the reference repository root. Do not write, edit or
delete anything — you have read access only, and producing the list is the
whole task.`;

const INVENTORY_SCHEMA = {
  type: "object",
  properties: {
    files: {
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
  required: ["files", "notes"],
};

/**
 * Returns the inventory, or null when there is nothing to scan or the scan
 * failed. Null is a degraded run, not a broken one: the later stages still
 * have read access to the reference repos, they just have to find their own
 * way around. The caller reports which of the two happened.
 */
export async function inventoryReferences(spec: SpecInput): Promise<ReferenceInventory | null> {
  const directories = referenceDirectories(spec.referencePaths);
  if (!directories.length) return null;

  const options: Options = {
    systemPrompt: SYSTEM_PROMPT,
    allowedTools: ["Read", "Glob", "Grep"],
    additionalDirectories: directories,
    model: config.model,
    maxTurns: config.maxTurns.referenceInventory,
  };

  const prompt = [
    "--- Spec (what the work has to produce) ---",
    spec.specMarkdown,
    "",
    "--- Reference repositories to inventory ---",
    ...directories,
  ].join("\n");

  const result = await runStructuredQuery<ReferenceInventory>(prompt, options, INVENTORY_SCHEMA);
  if (!result.ok || !result.data) return null;
  return result.data;
}
