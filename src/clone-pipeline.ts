import { checkCoverage, describeCoverage } from "./clone-coverage.js";
import { verifyCloneBuild, type CloneBuildVerdict } from "./stages/clone-build.js";
import { mapCloneTargets } from "./stages/clone-mapping.js";
import { portCloneGroup, portGroups } from "./stages/clone-port.js";
import { inventoryReferences } from "./stages/reference-inventory.js";
import { readTargetConventions } from "./stages/target-conventions.js";
import { StageError } from "./stage-error.js";
import { clearCheckpoint, fingerprint, loadCheckpoint, saveCheckpoint } from "./checkpoint.js";
import { findFreePorts } from "./free-ports.js";
import { getCachedTargetConventions, storeTargetConventions } from "./target-conventions-cache.js";
import type { CloneRunLogger } from "./run-log.js";
import type { CloneInput, CloneMapping, ReferenceInventory, TargetConventions } from "./types.js";

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
  /** Discard any progress saved by a stopped run and start from the beginning. */
  fresh?: boolean;
}

export async function runClonePipeline(opts: ClonePipelineOptions): Promise<ClonePipelineResult> {
  try {
    const result = await runCloneInner(opts);
    opts.logger?.finish(result.status, result.message);
    const logPath = await opts.logger?.write();
    return { ...result, logPath };
  } catch (error) {
    console.error("Clone pipeline crashed:", error);
    const message =
      error instanceof StageError
        ? `${error.message}\n\nThe run stopped here and was not retried. Groups ported before it are on disk, and progress is saved: running the same clone again resumes at this group. Start fresh (--fresh) to redo everything.`
        : "An unexpected error occurred. Check the console output above for details.";
    opts.logger?.finish("errored", message);
    const logPath = await opts.logger?.write();
    return { status: "errored", message, logPath };
  }
}

/**
 * What a stopped clone run leaves for the next one: the decided mapping and
 * the groups already written. Saved after the mapping and after every group.
 */
export interface CloneCheckpoint {
  inventory: ReferenceInventory;
  conventions: TargetConventions | null;
  mapping: CloneMapping;
  completedGroups: { group: string; summary: string }[];
}

type CloneOutcome = Omit<ClonePipelineResult, "logPath">;

async function runCloneInner(opts: ClonePipelineOptions): Promise<CloneOutcome> {
  const { clone, onProgress = () => {}, logger, skipBuild = false } = opts;
  const checkpointKey = fingerprint([clone.what, [...clone.referencePaths].sort()]);

  const plan = await resumeOrPlanClone(opts, checkpointKey);
  if (!("mapping" in plan)) return plan;

  const { inventory, conventions, mapping } = plan;
  const completedGroups = [...plan.completedGroups];
  const uncertain = mapping.entries.filter((entry) => entry.uncertain).length;

  // --- 4. Port, group by group ---
  const groups = portGroups(mapping);

  for (const [index, group] of groups.entries()) {
    if (completedGroups.some((done) => done.group === group)) continue;

    onProgress(`Clone port: ${group} (${index + 1}/${groups.length})`);
    const summary = await portCloneGroup({
      clone,
      mapping,
      conventions,
      group,
      completedGroups: [...completedGroups],
      runtimePorts: await findFreePorts(),
    });
    logger?.recordClonePort(group, summary);
    completedGroups.push({ group, summary });
    await saveCheckpoint<CloneCheckpoint>("clone", clone.projectPath, checkpointKey, {
      inventory,
      conventions,
      mapping,
      completedGroups: [...completedGroups],
    });
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
    build = await verifyCloneBuild(mapping, await findFreePorts());
    logger?.recordCloneBuild(build);
    onProgress(`Clone build: ${build.ok ? "pass" : "fail"}`);
  }

  const outcome = summarise(clone, mapping, coverage, build, uncertain);
  // A finished port has nothing to resume; an incomplete one keeps its
  // progress, so re-running after a hand fix goes straight to coverage + build.
  if (outcome.status === "done") await clearCheckpoint("clone", clone.projectPath);
  return outcome;
}

/**
 * Picks up a stopped clone run's mapping when there is one for this exact
 * request, otherwise locates, reads conventions and maps from scratch.
 */
async function resumeOrPlanClone(
  opts: ClonePipelineOptions,
  checkpointKey: string,
): Promise<CloneCheckpoint | CloneOutcome> {
  const { clone, onProgress = () => {}, logger, fresh = false } = opts;

  if (fresh) {
    await clearCheckpoint("clone", clone.projectPath);
    onProgress("Resume: fresh start requested — any saved progress was discarded");
    return planClone(opts, checkpointKey);
  }

  const saved = await loadCheckpoint<CloneCheckpoint>("clone", clone.projectPath, checkpointKey);
  if (saved.status === "stale") {
    onProgress("Resume: the saved progress is for a different clone request — starting fresh");
  }
  if (saved.status !== "found") return planClone(opts, checkpointKey);

  if (!isCloneCheckpoint(saved.data)) {
    onProgress("Resume: the saved progress is unreadable — starting fresh");
    return planClone(opts, checkpointKey);
  }
  if (portedFilesAreGone(saved.data, clone.projectPath)) {
    onProgress("Resume: none of the files the finished groups wrote are on disk any more — starting fresh");
    return planClone(opts, checkpointKey);
  }

  const data = saved.data;
  const groups = portGroups(data.mapping);
  onProgress(
    `Resume: continuing the clone stopped at ${saved.savedAt} — ${data.completedGroups.length}/${groups.length} group(s) already ported (start fresh to redo everything)`,
  );
  onProgress(`Clone locate: reused from the stopped run — ${data.inventory.files.length} source file(s)`);
  onProgress("Clone conventions: reused from the stopped run");
  onProgress(`Clone mapping: reused from the stopped run — ${data.mapping.entries.length} file(s) mapped`);

  logger?.recordReferenceInventory(data.inventory);
  logger?.recordTargetConventions(data.conventions);
  logger?.recordCloneMapping(data.mapping);
  for (const done of data.completedGroups) {
    logger?.recordClonePort(done.group, `(ported in the stopped run) ${done.summary}`);
  }
  return data;
}

async function planClone(opts: ClonePipelineOptions, checkpointKey: string): Promise<CloneCheckpoint | CloneOutcome> {
  const { clone, onProgress = () => {}, logger } = opts;

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
  let conventions: TargetConventions | null = await getCachedTargetConventions(clone.projectPath);
  if (conventions) {
    onProgress("Clone conventions: reused from a previous run (target project unchanged)");
  } else {
    conventions = await readTargetConventions(clone);
    if (conventions) await storeTargetConventions(clone.projectPath, conventions);
    onProgress(
      conventions
        ? "Clone conventions: target layout understood"
        : "Clone conventions: unavailable — mapping will read the target itself",
    );
  }
  logger?.recordTargetConventions(conventions);

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

  // Saved before any file is written: from here on, a stopped run costs the
  // next one nothing for locate, conventions or mapping.
  const plan: CloneCheckpoint = { inventory, conventions, mapping, completedGroups: [] };
  await saveCheckpoint("clone", clone.projectPath, checkpointKey, plan);
  return plan;
}

function isCloneCheckpoint(data: unknown): data is CloneCheckpoint {
  const candidate = data as CloneCheckpoint;
  return (
    Array.isArray(candidate?.inventory?.files) &&
    Array.isArray(candidate.mapping?.entries) &&
    candidate.mapping.entries.length > 0 &&
    Array.isArray(candidate.completedGroups)
  );
}

/**
 * Whether the finished groups' files have plainly been deleted since the run
 * stopped. Every target in a finished group missing means a wiped project, not
 * a rename; a false positive costs a fresh run, never a wrong result.
 */
function portedFilesAreGone(data: CloneCheckpoint, projectPath: string): boolean {
  const done = new Set(data.completedGroups.map((entry) => entry.group));
  const targets = data.mapping.entries.filter((entry) => done.has(entry.group));
  if (!targets.length) return false;
  const missing = checkCoverage({ entries: targets, notes: "" }, projectPath).missing;
  return missing.length === targets.length;
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
