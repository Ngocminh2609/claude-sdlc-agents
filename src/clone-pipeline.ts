import { checkCoverage, describeCoverage } from "./clone-coverage.js";
import { verifyCloneBuild, type CloneBuildVerdict } from "./stages/clone-build.js";
import { mapCloneTargets } from "./stages/clone-mapping.js";
import { portCloneGroup, portGroups } from "./stages/clone-port.js";
import { inventoryReferences } from "./stages/reference-inventory.js";
import { readTargetConventions } from "./stages/target-conventions.js";
import type { CloneRunLogger } from "./run-log.js";
import type { CloneInput, CloneMapping, TargetConventions } from "./types.js";

/**
 * Clone mode: port an existing feature from a reference repo into a target
 * project, end to end, from a one-line request.
 *
 * It is a different pipeline from `runPipeline`, not a flag on it, because the
 * questions are different. Feature work asks "what should we build" and
 * answers it with a design somebody has to approve. A port already has the
 * answer in the source; what it has to decide is placement, and what it has to
 * prove is coverage. So the design/review loop is gone, and in its place are a
 * mapping the user can read and a coverage check a machine can settle.
 *
 * It never reports "done" on an unverified run. Missing files or a failing
 * build come back as `incomplete`, with the list, because a port that quietly
 * dropped three files while reporting success is worse than one that stops.
 */

export interface ClonePipelineResult {
  status: "done" | "incomplete" | "errored";
  message: string;
  logPath?: string;
}

export interface ClonePipelineOptions {
  clone: CloneInput;
  onProgress?: (message: string) => void;
  logger?: CloneRunLogger;
  /** Skip the build check — for a target that cannot build on this machine. */
  skipBuild?: boolean;
}

export async function runClonePipeline(opts: ClonePipelineOptions): Promise<ClonePipelineResult> {
  try {
    const result = await runCloneInner(opts);
    opts.logger?.finish(result.status, result.message);
    const logPath = await opts.logger?.write();
    return { ...result, logPath };
  } catch (error) {
    console.error("Clone pipeline crashed:", error);
    const message = "An unexpected error occurred. Check the console output above for details.";
    opts.logger?.finish("errored", message);
    const logPath = await opts.logger?.write();
    return { status: "errored", message, logPath };
  }
}

async function runCloneInner(
  opts: ClonePipelineOptions,
): Promise<Omit<ClonePipelineResult, "logPath">> {
  const { clone, onProgress = () => {}, logger, skipBuild = false } = opts;

  // --- 1. Locate: what in the reference belongs to this feature ---
  onProgress("Clone locate: searching the reference repositories");
  const inventory = await inventoryReferences({
    specMarkdown: locatePrompt(clone),
    projectPath: clone.projectPath,
    referencePaths: clone.referencePaths,
  });
  logger?.recordReferenceInventory(inventory);

  if (!inventory?.files.length) {
    return {
      status: "incomplete",
      message: [
        `Found nothing in the reference repositories for "${clone.what}".`,
        "",
        "Nothing was written to the target project. Either the reference paths do not",
        "contain this feature, or it is named differently there — narrow --from to the",
        "module that holds it, or describe it the way the reference code names it.",
      ].join("\n"),
    };
  }
  onProgress(`Clone locate: ${inventory.files.length} source file(s) found`);

  // --- 2. Conventions: how the target is organised ---
  onProgress("Clone conventions: reading the target project");
  const conventions: TargetConventions | null = await readTargetConventions(clone);
  logger?.recordTargetConventions(conventions);
  onProgress(
    conventions
      ? "Clone conventions: target layout understood"
      : "Clone conventions: unavailable — mapping will read the target itself",
  );

  // --- 3. Mapping: where each file goes ---
  onProgress("Clone mapping: deciding where each file goes");
  const mapping: CloneMapping | null = await mapCloneTargets(clone, inventory, conventions);
  logger?.recordCloneMapping(mapping);

  if (!mapping) {
    return {
      status: "incomplete",
      message: [
        "Could not produce a file mapping, so nothing was ported.",
        "",
        "This stops before writing anything on purpose: porting without an agreed",
        "mapping is how each file ends up in a different package.",
      ].join("\n"),
    };
  }

  const uncertain = mapping.entries.filter((entry) => entry.uncertain).length;
  onProgress(
    `Clone mapping: ${mapping.entries.length} file(s) mapped${uncertain ? `, ${uncertain} uncertain` : ""}`,
  );

  // --- 4. Port, group by group ---
  const groups = portGroups(mapping);
  const completedGroups: { group: string; summary: string }[] = [];

  for (const [index, group] of groups.entries()) {
    onProgress(`Clone port: ${group} (${index + 1}/${groups.length})`);
    const summary = await portCloneGroup({
      clone,
      mapping,
      conventions,
      group,
      completedGroups: [...completedGroups],
    });
    logger?.recordClonePort(group, summary);
    completedGroups.push({ group, summary });
  }

  // --- 5. Coverage: settled by the filesystem, not by an opinion ---
  const coverage = checkCoverage(mapping, clone.projectPath);
  logger?.recordCloneCoverage(coverage);
  onProgress(`Clone coverage: ${describeCoverage(coverage)}`);
  // A separate line rather than leaving the shortfall to be read out of a
  // fraction: this is the one number that says whether the clone is whole, so
  // a front end should not have to parse "2/3" to notice.
  if (coverage.missing.length) {
    onProgress(`Clone coverage: ${coverage.missing.length} file(s) missing`);
  }

  // --- 6. Build ---
  let build: CloneBuildVerdict | null = null;
  if (skipBuild) {
    onProgress("Clone build: skipped (--no-build)");
  } else {
    onProgress("Clone build: compiling the target project");
    build = await verifyCloneBuild(mapping);
    logger?.recordCloneBuild(build);
    onProgress(`Clone build: ${build.ok ? "pass" : "fail"}`);
  }

  return summarise(clone, mapping, coverage, build, uncertain);
}

function summarise(
  clone: CloneInput,
  mapping: CloneMapping,
  coverage: { present: string[]; missing: string[] },
  build: CloneBuildVerdict | null,
  uncertain: number,
): Omit<ClonePipelineResult, "logPath"> {
  const lines = [
    `Ported "${clone.what}" — ${describeCoverage(coverage)}.`,
    build ? `Build: ${build.ok ? "pass" : "fail"} — ${build.summary}` : "Build: not checked.",
  ];

  if (coverage.missing.length) {
    lines.push("", "Files the mapping promised but that are not on disk:");
    for (const missing of coverage.missing) lines.push(`- ${missing}`);
  }

  if (uncertain) {
    lines.push(
      "",
      `${uncertain} mapping entr${uncertain === 1 ? "y was" : "ies were"} marked uncertain — check those placements in the report before committing.`,
    );
  }

  if (build && !build.ok && build.errors?.length) {
    lines.push("", "Build errors:");
    for (const error of build.errors.slice(0, 20)) lines.push(`- ${error}`);
  }

  const complete = coverage.missing.length === 0 && (build === null || build.ok);
  lines.push(
    "",
    complete
      ? "Review the diff in the target project (git status / git diff) and commit when ready."
      : "The ported code is on disk and was not reverted. Finish the gaps above by hand.",
  );

  return { status: complete ? "done" : "incomplete", message: lines.join("\n") };
}

/**
 * The inventory stage takes a spec; a clone run has a sentence. Turning one
 * into the other here keeps that stage single-purpose and reusable instead of
 * teaching it about clone mode.
 */
function locatePrompt(clone: CloneInput): string {
  return [
    `# Port "${clone.what}" into another project`,
    "",
    "Find everything in the reference repositories that implements this feature,",
    "across every layer it touches: database scripts, server code (controllers,",
    "services, repositories, entities, DTOs, mappers, validation, configuration,",
    "permissions), client code (pages, components, routing, API clients, state,",
    "translations) and any tests or fixtures that belong to it.",
    "",
    "A file that is not listed will not be ported, so err towards including a",
    "file you are unsure about and saying so, rather than leaving it out.",
  ].join("\n");
}
