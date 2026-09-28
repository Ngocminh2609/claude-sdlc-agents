import { checkCoverage, describeCoverage } from "./clone-coverage.js";
import { checkWiring, describeServerApi, describeWiring, portedServerApi, wiringIsSound } from "./clone-wiring.js";
import { verifyCloneBuild, type CloneBuildVerdict } from "./stages/clone-build.js";
import { mapCloneTargets } from "./stages/clone-mapping.js";
import { fixCloneFailures, groupLayer, layerOf, portCloneGroup, portGroups } from "./stages/clone-port.js";
import { runCloneTests } from "./stages/clone-tests.js";
import { inventoryReferences } from "./stages/reference-inventory.js";
import { readTargetConventions } from "./stages/target-conventions.js";
import { StageError } from "./stage-error.js";
import { clearCheckpoint, fingerprint, loadCheckpoint, saveCheckpoint } from "./checkpoint.js";
import { config } from "./config.js";
import { indexFor, searchIndexes } from "./project-index.js";
import { cachedStage, repoVersions } from "./stage-cache.js";
import { findFreePorts } from "./free-ports.js";
import { keywordVariants } from "./keyword-variants.js";
import { metadataStandardsFingerprint } from "./metadata-standards.js";
import { skillCatalogFingerprint } from "./skills-catalog.js";
import { referenceRootsPromptSection, rootsOf, type ProjectRoot } from "./target-roots.js";
import { getCachedTargetConventions, storeTargetConventions } from "./target-conventions-cache.js";
import type { CloneRunLogger } from "./run-log.js";
import type {
  CloneCoverage,
  CloneDeviation,
  CloneLayer,
  CloneTestVerdict,
  CloneWiring,
  CloneInput,
  CloneMapping,
  ReferenceInventory,
  TargetConventions,
} from "./types.js";

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
  /** Skip writing and running unit tests. */
  skipTests?: boolean;
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
  completedGroups: { group: string; summary: string; deviations?: CloneDeviation[] }[];
}

type CloneOutcome = Omit<ClonePipelineResult, "logPath">;

const CLONE_PLAN_VERSION = "clone-plan-v2";

async function runCloneInner(opts: ClonePipelineOptions): Promise<CloneOutcome> {
  const { clone, onProgress = () => {}, logger, skipBuild = false, skipTests = false } = opts;
  const roots = rootsOf(clone);
  const checkpointKey = fingerprint([
    // Bumped when the mapping's contract changes, so a mapping saved under the
    // old rules is not resumed: v2 added layers and dropped "generate later".
    CLONE_PLAN_VERSION,
    clone.what,
    [...clone.referencePaths].sort(),
    (clone.referenceRoots ?? []).map((root) => `${root.role}:${root.path}`),
    roots.map((root) => `${root.role}:${root.path}`),
    // The mapping and port groups were produced under these rules; different rules need a new plan.
    metadataStandardsFingerprint(clone.metadataStandards),
    skillCatalogFingerprint(clone.skillCatalog),
  ]);

  const plan = await resumeOrPlanClone(opts, checkpointKey);
  if (!("mapping" in plan)) return plan;

  const { inventory, conventions, mapping } = plan;
  const target = forLaterStages(clone, inventory);
  const completedGroups = [...plan.completedGroups];
  const uncertain = mapping.entries.filter((entry) => entry.uncertain).length;
  if (missingSchemaScript(mapping)) {
    onProgress("Clone mapping: warning — entities are ported but no database script is mapped");
  }

  // --- 4. Port, group by group: database scripts, then server, then client ---
  const groups = portGroups(mapping);

  for (const [index, group] of groups.entries()) {
    if (completedGroups.some((done) => done.group === group)) continue;

    const layer = groupLayer(mapping, group);
    onProgress(`Clone port: ${group} (${index + 1}/${groups.length}) — ${LAYER_LABEL[layer]}`);
    // A client group is written against the server routes on disk now, read
    // from the code the server groups just wrote — not the reference's routes.
    const serverApi = layer === "fe" ? describeServerApi(portedServerApi(mapping, roots)) : undefined;
    if (serverApi) onProgress(`Clone port: ${group} is wired to ${serverApi.length} server route(s) read from the ported code`);
    const { summary, deviations } = await portCloneGroup({
      clone: target,
      mapping,
      conventions,
      group,
      completedGroups: [...completedGroups],
      runtimePorts: await findFreePorts(),
      serverApi,
    });
    logger?.recordClonePort(group, summary);
    completedGroups.push({ group, summary, deviations });
    await saveCheckpoint<CloneCheckpoint>("clone", clone.projectPath, checkpointKey, {
      inventory,
      conventions,
      mapping,
      completedGroups: [...completedGroups],
    });
  }

  // --- 5. Coverage: settled by the filesystem, not by an opinion ---
  const deviations = completedGroups.flatMap((done) => done.deviations ?? []);
  const coverage = checkCoverage(mapping, roots, deviations);
  logger?.recordCloneCoverage(coverage);
  onProgress(`Clone coverage: ${describeCoverage(coverage)}`);
  // A separate line rather than leaving the shortfall to be read out of a
  // fraction: this is the one number that says whether the clone is whole, so
  // a front end should not have to parse "2/3" to notice.
  if (coverage.missing.length) {
    onProgress(`Clone coverage: ${coverage.missing.length} file(s) missing`);
  }

  // --- 6. Wiring: does the ported client reach anything? Plain code, and it
  // runs even with the build skipped — it is the check that notices a page
  // importing an API client nobody wrote.
  let wiring = checkWiringAndReport(mapping, roots, onProgress, logger);

  // --- 7. Build, 8. Unit tests, then fix rounds until both pass ---
  const serverApi = describeServerApi(portedServerApi(mapping, roots));
  const runBuild = async (): Promise<CloneBuildVerdict> => {
    onProgress("Clone build: compiling the target project");
    const verdict = await verifyCloneBuild(mapping, await findFreePorts(), roots);
    logger?.recordCloneBuild(verdict);
    onProgress(`Clone build: ${verdict.ok ? "pass" : "fail"}`);
    return verdict;
  };
  const runTests = async (previous?: CloneTestVerdict): Promise<CloneTestVerdict> => {
    // Re-run the same commands when the first run left some; otherwise (it
    // produced no verdict) write and run again.
    const rerun = previous?.commands.length ? previous : undefined;
    onProgress(
      rerun ? "Clone tests: re-running the unit tests" : "Clone tests: writing and running unit tests for the CRUD flow",
    );
    const verdict = await runCloneTests({
      clone: target,
      mapping,
      conventions,
      roots,
      serverApi,
      runtimePorts: await findFreePorts(),
      rerun,
    });
    logger?.recordCloneTests(verdict);
    onProgress(`Clone tests: ${describeTests(verdict)}`);
    return verdict;
  };

  let build: CloneBuildVerdict | null = null;
  if (skipBuild) onProgress("Clone build: skipped (--no-build)");
  else build = await runBuild();

  let tests: CloneTestVerdict | null = null;
  if (skipTests) onProgress("Clone tests: skipped (--no-tests)");
  else tests = await runTests();

  const fixes: string[] = [];
  for (let round = 1; round <= config.maxCloneFixRounds; round++) {
    const failures = failuresOf(build, tests);
    if (!failures.length) break;
    onProgress(`Clone fix: round ${round}/${config.maxCloneFixRounds} — ${failures.length} failure(s) to fix`);
    const summary = await fixCloneFailures({ clone: target, mapping, conventions, failures, serverApi, round });
    fixes.push(summary);
    logger?.recordCloneFix(round, summary);
    if (build) build = await runBuild();
    if (tests) tests = await runTests(tests);
  }
  // A fix may have touched the client; the wiring verdict must describe the
  // code as it is now.
  if (fixes.length) wiring = checkWiringAndReport(mapping, roots, onProgress, logger);

  const outcome = summarise(clone, mapping, coverage, wiring, build, tests, fixes, uncertain, deviations);
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
  if (portedFilesAreGone(saved.data, rootsOf(clone))) {
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
  const { clone, onProgress = () => {}, logger, fresh = false } = opts;
  const roots = rootsOf(clone);

  // --- 1. Locate: what in the reference belongs to this feature ---
  onProgress("Clone locate: searching the reference repositories");
  // The likeliest files, found by plain code in the reference indexes, go
  // straight into the prompt: the agent confirms and completes the list
  // instead of discovering it from an empty start.
  const referenceIndexes = (clone.projectIndexes ?? []).filter((index) =>
    clone.referencePaths.some((reference) => indexFor([index], reference)),
  );
  const candidates = await searchIndexes(referenceIndexes, keywordVariants(clone.what), 80);
  const specMarkdown = locatePrompt(clone, candidates);
  const referenceVersions = repoVersions(clone.projectIndexes, clone.referencePaths);
  const inventory = await cachedStage({
    kind: "clone-locate",
    // Same keyword against unchanged reference repos → same answer.
    key: referenceVersions && [CLONE_PLAN_VERSION, clone.what, clone.referencePaths, referenceVersions],
    fresh,
    run: () =>
      inventoryReferences({
        specMarkdown,
        projectPath: clone.projectPath,
        referencePaths: clone.referencePaths,
        projectIndexes: clone.projectIndexes,
      }),
    onHit: (savedAt) =>
      onProgress(`Clone locate: reused from ${savedAt} — same keyword, reference repositories unchanged since`),
  });
  logger?.recordReferenceInventory(inventory);

  if (!inventory?.files.length) {
    return {
      status: "incomplete",
      message: [
        `Found nothing in the reference repositories for "${clone.what}".`,
        "",
        "Nothing was written to the target project. Either the reference folders do not",
        "contain this feature, or the keyword is too far from how the code names it — try",
        "another keyword (Vietnamese or English), or point the reference at the module that",
        "holds it.",
      ].join("\n"),
    };
  }
  if (inventory.resolvedFeature?.trim()) {
    const others = inventory.alternatives?.length ?? 0;
    onProgress(
      `Clone locate: keyword "${clone.what}" matched "${inventory.resolvedFeature.trim()}"${
        others ? ` (best of ${others + 1} candidates — the others are listed in the report)` : ""
      }`,
    );
  }
  onProgress(`Clone locate: ${inventory.files.length} source file(s) found`);
  const target = forLaterStages(clone, inventory);

  // --- 2. Conventions: how the target is organised ---
  onProgress("Clone conventions: reading the target project");
  let conventions: TargetConventions | null = await getCachedTargetConventions(roots, clone.projectIndexes);
  if (conventions) {
    onProgress("Clone conventions: reused from a previous run (target project structure unchanged)");
  } else {
    conventions = await readTargetConventions(target);
    if (conventions) await storeTargetConventions(roots, conventions, clone.projectIndexes);
    onProgress(
      conventions
        ? "Clone conventions: target layout understood"
        : "Clone conventions: unavailable — mapping will read the target itself",
    );
  }
  logger?.recordTargetConventions(conventions);

  // --- 3. Mapping: where each file goes ---
  onProgress("Clone mapping: deciding where each file goes");
  const mapping: CloneMapping | null = await mapCloneTargets(target, inventory, conventions);
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
function portedFilesAreGone(data: CloneCheckpoint, roots: ProjectRoot[]): boolean {
  const done = new Set(data.completedGroups.map((entry) => entry.group));
  const targets = data.mapping.entries.filter((entry) => done.has(entry.group));
  if (!targets.length) return false;
  const missing = checkCoverage({ entries: targets, notes: "" }, roots).missing;
  return missing.length === targets.length;
}

function checkWiringAndReport(
  mapping: CloneMapping,
  roots: ProjectRoot[],
  onProgress: (message: string) => void,
  logger: CloneRunLogger | undefined,
): CloneWiring {
  const wiring = checkWiring(mapping, roots);
  logger?.recordCloneWiring(wiring);
  onProgress(`Clone wiring: ${describeWiring(wiring)}`);
  const problems = wiring.unresolvedImports.length + wiring.unmatchedCalls.length;
  if (problems) onProgress(`Clone wiring: ${problems} problem(s)`);
  return wiring;
}

const LAYER_LABEL: Record<CloneLayer, string> = {
  db: "database scripts",
  be: "server code",
  fe: "client code",
};

function describeTests(tests: CloneTestVerdict): string {
  const counts =
    tests.passed !== undefined || tests.failed !== undefined
      ? ` — ${tests.passed ?? 0} passed, ${tests.failed ?? tests.failures.length} failed`
      : "";
  return `${tests.ok ? "pass" : "fail"}${counts}`;
}

/** What a fix round has to work from: build errors and failing tests, verbatim. */
function failuresOf(build: CloneBuildVerdict | null, tests: CloneTestVerdict | null): string[] {
  const failures: string[] = [];
  if (build && !build.ok) {
    failures.push(...(build.errors?.length ? build.errors : [build.summary]).map((error) => `[build] ${error}`));
  }
  if (tests && !tests.ok) {
    failures.push(...(tests.failures.length ? tests.failures : [tests.summary]).map((failure) => `[test] ${failure}`));
  }
  return failures;
}

/**
 * A mapping that ports entities but no database script, for a target that
 * creates its tables by script, compiles and then fails on the first query.
 * Detected from paths only, so it is a warning for the report, not a verdict.
 */
function missingSchemaScript(mapping: CloneMapping): boolean {
  const hasDb = mapping.entries.some((entry) => layerOf(entry) === "db");
  const hasEntity = mapping.entries.some(
    (entry) => layerOf(entry) === "be" && /(^|\/)(entity|entities|domain|model)\/[^/]+\.(java|kt)$/i.test(entry.target),
  );
  return hasEntity && !hasDb;
}

function summarise(
  clone: CloneInput,
  mapping: CloneMapping,
  coverage: CloneCoverage,
  wiring: CloneWiring,
  build: CloneBuildVerdict | null,
  tests: CloneTestVerdict | null,
  fixes: string[],
  uncertain: number,
  deviations: CloneDeviation[],
): Omit<ClonePipelineResult, "logPath"> {
  const lines = [
    `Ported "${clone.what}" — ${describeCoverage(coverage)}.`,
    `Wiring: ${describeWiring(wiring)}.`,
    build ? `Build: ${build.ok ? "pass" : "fail"} — ${build.summary}` : "Build: not checked.",
    tests ? `Unit tests: ${describeTests(tests)} — ${tests.summary}` : "Unit tests: not run.",
    ...(fixes.length ? [`Fix rounds: ${fixes.length} (build/test failures were fixed in the ported code)`] : []),
  ];

  if (missingSchemaScript(mapping)) {
    lines.push(
      "",
      "Warning: server entities were ported but no database script was. If the target creates its tables by script (not by the ORM at startup), the feature will fail on its first query.",
    );
  }

  if (tests && !tests.ok && tests.failures.length) {
    lines.push("", "Failing unit tests:");
    for (const failure of tests.failures.slice(0, 20)) lines.push(`- ${failure}`);
  }
  if (tests?.testFiles.length) {
    lines.push("", "Unit tests written:");
    for (const file of tests.testFiles) lines.push(`- ${file}`);
  }

  if (wiring.unresolvedImports.length) {
    lines.push("", "Imports in ported files that resolve to nothing (the page cannot load):");
    for (const miss of wiring.unresolvedImports) lines.push(`- ${miss.file}: '${miss.specifier}'`);
  }

  if (wiring.unmatchedCalls.length) {
    lines.push("", "API calls no server controller maps (the call would 404):");
    for (const call of wiring.unmatchedCalls) lines.push(`- ${call.file}: ${call.method ?? "?"} ${call.url}`);
  }

  if (coverage.missing.length) {
    const reasons = new Map(deviations.map((deviation) => [deviation.target, deviation]));
    lines.push("", "Files the mapping promised but that are not on disk:");
    for (const missing of coverage.missing) {
      const why = reasons.get(missing);
      lines.push(`- ${missing}${why ? ` — declared ${why.kind}: ${why.reason}` : ""}`);
    }
  }

  if (coverage.merged?.length) {
    lines.push("", "Not written as separate files, by the target's own conventions (checked on disk):");
    for (const merged of coverage.merged) lines.push(`- ${merged.target} -> in ${merged.coveredBy} (${merged.reason})`);
  }

  if (coverage.excluded?.length) {
    lines.push(
      "",
      "Source files the mapping decided NOT to port (a duplicate/superseded/read-only sibling variant — not counted as missing, but a person should still check the reasoning):",
    );
    for (const skipped of coverage.excluded) lines.push(`- ${skipped.source} — ${skipped.changes}`);
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

  const complete =
    coverage.missing.length === 0 &&
    wiringIsSound(wiring) &&
    (build === null || build.ok) &&
    (tests === null || tests.ok);
  lines.push(
    "",
    complete
      ? "Review the diff in the target project (git status / git diff) and commit when ready."
      : "The ported code is on disk and was not reverted. Finish the gaps above by hand.",
  );

  return { status: complete ? "done" : "incomplete", message: lines.join("\n") };
}

/**
 * The inventory stage takes a spec; a clone run has a keyword. Turning one
 * into the other here keeps that stage single-purpose and reusable instead of
 * teaching it about clone mode.
 *
 * The keyword is loose on purpose — Vietnamese or English, a fragment of the
 * feature's name rather than its exact title. The mechanical spellings are
 * computed here (`keywordVariants`); translating and picking the feature are
 * the model's job, and when the keyword fits several features it picks the
 * best match and names the rest rather than stopping.
 */
function locatePrompt(clone: CloneInput, candidates: string[] = []): string {
  const candidateSection = candidates.length
    ? [
        "",
        "--- Index lines matching the keyword's own spellings (found by plain text search, not by meaning) ---",
        "Start from these: they are the files whose path, class, table or Vietnamese UI text contains",
        "the keyword. Confirm which feature they belong to, then use the project index (Grep it) to",
        "find the rest of that feature — translations of the keyword will not appear here.",
        ...candidates.map((line) => `- ${line.length > 240 ? `${line.slice(0, 240)}…` : line}`),
      ]
    : [];
  return [
    `# Port the feature matching the keyword "${clone.what}" into another project`,
    "",
    "The keyword is what a person typed — Vietnamese or English, possibly just part of the",
    "feature's name. It is not an exact identifier. First work out which feature it means:",
    `- Spellings to search for as-is: ${keywordVariants(clone.what).join(", ")}`,
    "- Also translate it (Vietnamese <-> English) and search for the translations and close",
    "  synonyms as they would appear in code: e.g. 'nghề nghiệp' -> occupation, job, career;",
    "  'đơn vị tính' -> unit, uom, measure.",
    "- Look in file and folder names, class and table names, route paths, menu entries,",
    "  and translation / i18n files, where Vietnamese screen titles usually live.",
    "- If several features match, choose the single best one: the strongest name or",
    "  translation match, and the most complete feature (server + client + data). Put its",
    "  name in resolvedFeature, list the others in alternatives, and port only the best one.",
    ...referenceRootsPromptSection(clone.referenceRoots ?? []),
    "",
    "Then find everything in the reference repositories that implements that feature,",
    "across every layer it touches: database scripts, server code (controllers,",
    "services, repositories, entities, DTOs, mappers, validation, configuration,",
    "permissions), client code (pages, components, routing, API clients, state,",
    "translations) and any tests or fixtures that belong to it.",
    "",
    "A file that is not listed will not be ported, so err towards including a",
    "file you are unsure about and saying so, rather than leaving it out.",
    ...candidateSection,
  ].join("\n");
}

/**
 * The clone input the stages after locate see: the feature the keyword was
 * resolved to, rather than the bare keyword, so the mapping and port agents
 * are told exactly what they are porting. The original keyword stays in the
 * checkpoint fingerprint and the report.
 */
function forLaterStages(clone: CloneInput, inventory: ReferenceInventory): CloneInput {
  const resolved = inventory.resolvedFeature?.trim();
  return resolved ? { ...clone, what: `${resolved} (matched from the keyword "${clone.what}")` } : clone;
}
