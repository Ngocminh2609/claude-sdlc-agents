import { existsSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { runSpecsArch } from "./stages/specs-arch.js";
import { reviewSpecs } from "./stages/orchestrator-review.js";
import { inventoryReferences } from "./stages/reference-inventory.js";
import { inventoryProjectContext } from "./stages/project-context.js";
import { breakDownTasks } from "./stages/task-breakdown.js";
import { runCoding } from "./stages/coding.js";
import { runE2eTest } from "./stages/e2e-test.js";
import { clearCheckpoint, fingerprint, loadCheckpoint, saveCheckpoint } from "./checkpoint.js";
import { findFreePorts } from "./free-ports.js";
import { StageError } from "./stage-error.js";
import type { RunLogger } from "./run-log.js";
import type {
  CompletedTask,
  E2eVerdict,
  ProjectContext,
  ReferenceInventory,
  SpecInput,
  TaskItem,
} from "./types.js";

export interface PipelineResult {
  status: "done" | "escalated-specs" | "escalated-e2e" | "errored";
  message: string;
  logPath?: string;
}

export interface PipelineOptions {
  spec: SpecInput;
  onProgress?: (message: string) => void;
  logger?: RunLogger;
  /** Discard any progress saved by a stopped run and start from the beginning. */
  fresh?: boolean;
}

/**
 * Saved while the design is still under review, after the project scan and
 * after every rejected round — so a run that is stopped, killed, or runs out
 * of review rounds resumes by revising its last proposal instead of scanning
 * and designing from nothing again.
 */
export interface DesignCheckpoint {
  phase: "design";
  inventory: ReferenceInventory | null;
  projectContext: ProjectContext | null;
  /** null when the run stopped before the first proposal was written. */
  lastProposal: string | null;
  lastFeedback: string | null;
}

/**
 * Saved once the design is approved: the plan and the tasks already finished.
 * Written after the breakdown and after every task.
 */
export interface BuildCheckpoint {
  phase: "build";
  inventory: ReferenceInventory | null;
  projectContext: ProjectContext | null;
  approvedProposal: string;
  tasks: TaskItem[];
  completedTasks: CompletedTask[];
}

/** Everything a stopped run leaves for the next one (see `checkpoint.ts`). */
export type FeatureCheckpoint = DesignCheckpoint | BuildCheckpoint;

type RunOutcome = Omit<PipelineResult, "logPath">;

export async function runPipeline(opts: PipelineOptions): Promise<PipelineResult> {
  try {
    const result = await runPipelineInner(opts);
    opts.logger?.finish(result.status, result.message);
    const logPath = await opts.logger?.write();
    return { ...result, logPath };
  } catch (error) {
    console.error("Pipeline crashed:", error);
    const message =
      error instanceof StageError
        ? `${error.message}\n\nThe run stopped here and was not retried. Any progress saved before this point is picked up by the next run.`
        : "An unexpected error occurred. Check the console output above for details.";
    opts.logger?.finish("errored", message);
    const logPath = await opts.logger?.write();
    return { status: "errored", message, logPath };
  }
}

async function runPipelineInner(opts: PipelineOptions): Promise<RunOutcome> {
  const { spec, onProgress = () => {}, logger } = opts;
  const checkpointKey = featureFingerprint(spec);

  const plan = await resumeOrPlan(opts, checkpointKey);
  if (!("approvedProposal" in plan)) return plan;

  const { inventory, projectContext, approvedProposal, tasks } = plan;
  const completedTasks = [...plan.completedTasks];
  const saveProgress = () =>
    saveCheckpoint<FeatureCheckpoint>("feature", spec.projectPath, checkpointKey, {
      phase: "build",
      inventory,
      projectContext,
      approvedProposal,
      tasks,
      completedTasks: [...completedTasks],
    });

  // --- Coding & Unit Test, once per task, then E2E/QA once ---
  // One pass only, by design. The earlier loop re-coded every task from the
  // first one after an E2E failure — on a real 8-task run that re-spent the
  // whole coding budget, hit the account's usage limit and crashed. A failure
  // now stops the run and says exactly where, so a person decides what next;
  // the checkpoint lets the next run carry on from that point.
  for (const [index, task] of tasks.entries()) {
    if (completedTasks.some((done) => done.id === task.id)) continue;

    onProgress(`Coding: ${task.id} (${index + 1}/${tasks.length})`);
    let summary: string;
    try {
      summary = await runCoding({
        spec,
        task,
        approvedProposal,
        completedTasks: [...completedTasks],
        inventory,
        projectContext,
        runtimePorts: await findFreePorts(),
      });
    } catch (error) {
      if (!(error instanceof StageError)) throw error;
      return {
        status: "errored",
        message: codingStoppedMessage(error, task.id, index, tasks.map((t) => t.id), completedTasks),
      };
    }
    logger?.recordCoding(1, task.id, summary);
    completedTasks.push({ id: task.id, description: task.description, summary });
    await saveProgress();
  }

  onProgress("E2E/QA: running");
  const e2e = await runE2eTest(spec, approvedProposal, projectContext, await findFreePorts());
  logger?.recordE2e(1, e2e);
  onProgress(`E2E/QA verdict: ${e2e.verdict}`);

  if (e2e.verdict !== "pass") {
    return { status: "escalated-e2e", message: e2eFailedMessage(e2e) };
  }

  // Finished: nothing left to resume, and a later run of the same spec should
  // plan from the code as it now is.
  await clearCheckpoint("feature", spec.projectPath);
  return {
    status: "done",
    message: "E2E/QA passed. Review the changes in your working tree and commit when ready.",
  };
}

/**
 * Picks up a stopped run's saved progress when there is some for this exact
 * spec — an approved plan to keep building, or a design to keep revising —
 * otherwise plans from scratch. Returns the approved plan, or the outcome that
 * ends the run early (a design that was never approved).
 */
async function resumeOrPlan(opts: PipelineOptions, checkpointKey: string): Promise<BuildCheckpoint | RunOutcome> {
  const { spec, onProgress = () => {}, fresh = false } = opts;

  if (fresh) {
    await clearCheckpoint("feature", spec.projectPath);
    onProgress("Resume: fresh start requested — any saved progress was discarded");
    return planFromScratch(opts, checkpointKey, null);
  }

  const saved = await loadCheckpoint<FeatureCheckpoint>("feature", spec.projectPath, checkpointKey);
  if (saved.status === "stale") {
    onProgress("Resume: the saved progress is for a different spec or reference set — starting fresh");
  }
  if (saved.status !== "found") return planFromScratch(opts, checkpointKey, null);

  if (isBuildCheckpoint(saved.data)) {
    if (finishedCodeIsGone(saved.data, spec.projectPath)) {
      onProgress("Resume: none of the files the finished tasks wrote are on disk any more — starting fresh");
      return planFromScratch(opts, checkpointKey, null);
    }
    return resumeBuild(opts, saved.data, saved.savedAt);
  }

  if (isDesignCheckpoint(saved.data)) {
    onProgress(
      `Resume: continuing the design stopped at ${saved.savedAt} — ${
        saved.data.lastProposal
          ? "revising the last proposal with the reviewer's feedback"
          : "reusing the project scan"
      } (start fresh to redo everything)`,
    );
    return planFromScratch(opts, checkpointKey, saved.data);
  }

  onProgress("Resume: the saved progress is unreadable — starting fresh");
  return planFromScratch(opts, checkpointKey, null);
}

function resumeBuild(opts: PipelineOptions, data: BuildCheckpoint, savedAt: string): BuildCheckpoint {
  const { onProgress = () => {}, logger } = opts;
  const doneIds = data.completedTasks.map((task) => task.id);
  onProgress(
    `Resume: continuing the run stopped at ${savedAt} — ${doneIds.length}/${data.tasks.length} task(s) already done (start fresh to redo everything)`,
  );
  // The same stage messages a normal run emits, so the UI's stage strip and
  // task count come out right on a resumed run too.
  onProgress("Reference inventory: reused from the stopped run");
  onProgress("Specs & Arch: reused the approved design from the stopped run");
  onProgress("Orchestrator review: approve (from the stopped run)");
  onProgress(`${data.tasks.length} task(s) to implement`);

  logger?.recordResume(savedAt, doneIds);
  logger?.recordReferenceInventory(data.inventory);
  logger?.recordProjectContext(data.projectContext);
  logger?.recordSpecsArch(1, data.approvedProposal);
  logger?.recordReview(1, { decision: "approve", feedback: `Reused from the run stopped at ${savedAt}.` });
  logger?.recordTaskBreakdown(data.tasks);
  for (const task of data.completedTasks) {
    logger?.recordCoding(1, task.id, `(finished in the stopped run) ${task.summary}`);
  }
  return data;
}

/**
 * Scans (or reuses a saved scan), runs the design/review rounds, and breaks
 * the approved design into tasks. `start` is a saved design checkpoint to
 * continue from, or null for a clean start.
 */
async function planFromScratch(
  opts: PipelineOptions,
  checkpointKey: string,
  start: DesignCheckpoint | null,
): Promise<BuildCheckpoint | RunOutcome> {
  const { spec, onProgress = () => {}, logger } = opts;

  let inventory: ReferenceInventory | null;
  let projectContext: ProjectContext | null;

  if (start) {
    ({ inventory, projectContext } = start);
    onProgress("Reference inventory: reused from the stopped run");
  } else {
    ({ inventory, projectContext } = await scanInputs(opts));
  }
  logger?.recordReferenceInventory(inventory);
  logger?.recordProjectContext(projectContext);

  const saveDesign = (lastProposal: string | null, lastFeedback: string | null) =>
    saveCheckpoint<FeatureCheckpoint>("feature", spec.projectPath, checkpointKey, {
      phase: "design",
      inventory,
      projectContext,
      lastProposal,
      lastFeedback,
    });
  // Saved before any design work, so a run killed during the first proposal
  // does not pay for the project scan again.
  if (!start) await saveDesign(null, null);

  // --- Specs & Arch <-> Orchestrator review ---
  // A resumed design starts from the last proposal and the feedback it got,
  // with a fresh set of rounds — the proposal is revised, not rewritten.
  let proposal: string | null = start?.lastProposal ?? null;
  let feedback: string | undefined = start?.lastFeedback ?? undefined;
  let approvedProposal: string | null = null;

  for (let attempt = 1; attempt <= config.maxSpecAttempts; attempt++) {
    onProgress(`Specs & Arch: attempt ${attempt}/${config.maxSpecAttempts}`);
    proposal = await runSpecsArch(spec, proposal, feedback, inventory, projectContext);
    logger?.recordSpecsArch(attempt, proposal);
    const review = await reviewSpecs(spec, proposal);
    logger?.recordReview(attempt, review);
    onProgress(`Orchestrator review: ${review.decision}`);
    if (review.decision === "approve") {
      const amendments = (review.amendments ?? []).map((amendment) => amendment.trim()).filter(Boolean);
      if (amendments.length) {
        onProgress(`Orchestrator review: approved with ${amendments.length} amendment(s) for the coding stage`);
      }
      approvedProposal = withAmendments(proposal, amendments);
      break;
    }
    feedback = review.feedback;
    await saveDesign(proposal, feedback);
  }

  if (approvedProposal === null) {
    return {
      status: "escalated-specs",
      message: [
        `Design proposal not approved after ${config.maxSpecAttempts} attempts.`,
        "",
        "Last proposal:",
        proposal ?? "(none)",
        "",
        "Last reviewer feedback:",
        feedback ?? "(none)",
        "",
        "Progress is saved: running the same spec again keeps revising this last proposal with the",
        `feedback above (another ${config.maxSpecAttempts} rounds). If the feedback shows the spec itself is`,
        "unclear, edit the spec instead — that starts the design over.",
      ].join("\n"),
    };
  }

  // --- Task breakdown ---
  onProgress("Breaking approved design into tasks");
  const { tasks } = await breakDownTasks(spec, approvedProposal, inventory, projectContext);
  logger?.recordTaskBreakdown(tasks);
  onProgress(`${tasks.length} task(s) to implement`);

  // Saved before any code is written: from here on, a stopped run costs the
  // next one nothing for design, review or breakdown.
  const plan: BuildCheckpoint = {
    phase: "build",
    inventory,
    projectContext,
    approvedProposal,
    tasks,
    completedTasks: [],
  };
  await saveCheckpoint<FeatureCheckpoint>("feature", spec.projectPath, checkpointKey, plan);
  return plan;
}

async function scanInputs(
  opts: PipelineOptions,
): Promise<{ inventory: ReferenceInventory | null; projectContext: ProjectContext | null }> {
  const { spec, onProgress = () => {} } = opts;

  // --- Reference inventory (only when a sample project was given) ---
  let inventory: ReferenceInventory | null = null;
  if (spec.referencePaths?.length) {
    onProgress("Reference inventory: scanning the reference repositories");
    inventory = await inventoryReferences(spec);
    // A failed scan is a degraded run, not a failed one: the later stages
    // still have read access. Say so out loud rather than letting the run
    // look like it had a file list when it did not.
    onProgress(
      inventory
        ? `Reference inventory: ${inventory.files.length} file(s) to cover`
        : "Reference inventory: unavailable — continuing without a file list",
    );
  } else {
    onProgress("Reference inventory: skipped (no reference repository)");
  }

  // --- Project context: one scan of the target project itself, shared by
  // every stage below instead of each one rediscovering it independently ---
  onProgress("Project context: scanning the target project");
  const projectContext: ProjectContext | null = await inventoryProjectContext(spec);
  onProgress(
    projectContext
      ? "Project context: conventions and relevant files gathered"
      : "Project context: unavailable — stages will explore the project themselves",
  );

  return { inventory, projectContext };
}

/**
 * The reviewer's required amendments become part of the approved design, so
 * the breakdown, every coding task and E2E all see them — a fix the reviewer
 * could state exactly no longer costs a whole redesign round.
 */
function withAmendments(proposal: string, amendments: string[]): string {
  if (!amendments.length) return proposal;
  return [
    proposal,
    "",
    "--- Reviewer's required amendments (binding — part of the approved design; implement every one) ---",
    ...amendments.map((amendment) => `- ${amendment}`),
  ].join("\n");
}

/**
 * The inputs the saved plan was built from. A database connection string is
 * deliberately left out: it can carry a password, and changing it does not
 * change what was designed. A schema file's content is kept — it shaped the
 * design.
 */
function featureFingerprint(spec: SpecInput): string {
  return fingerprint([
    spec.specMarkdown,
    spec.dbInfo?.kind ?? null,
    spec.dbInfo?.kind === "schema-file" ? spec.dbInfo.value : null,
    [...(spec.referencePaths ?? [])].sort(),
  ]);
}

function isBuildCheckpoint(data: unknown): data is BuildCheckpoint {
  const candidate = data as BuildCheckpoint;
  return (
    candidate?.phase === "build" &&
    typeof candidate.approvedProposal === "string" &&
    Array.isArray(candidate.tasks) &&
    candidate.tasks.length > 0 &&
    Array.isArray(candidate.completedTasks)
  );
}

function isDesignCheckpoint(data: unknown): data is DesignCheckpoint {
  const candidate = data as DesignCheckpoint;
  return (
    candidate?.phase === "design" &&
    (candidate.lastProposal === null || typeof candidate.lastProposal === "string") &&
    (candidate.lastFeedback === null || typeof candidate.lastFeedback === "string")
  );
}

/**
 * Whether the finished tasks' code has plainly been deleted since the run
 * stopped — the case of someone clearing the project to start over but
 * forgetting to say so. Only decided when the finished tasks named the files
 * they own, and only when every one of them is missing: one missing file is a
 * rename, all of them is a wiped project. A false positive costs a fresh run,
 * never a wrong result.
 */
function finishedCodeIsGone(data: BuildCheckpoint, projectPath: string): boolean {
  const doneIds = new Set(data.completedTasks.map((task) => task.id));
  const files = data.tasks
    .filter((task) => doneIds.has(task.id))
    .flatMap((task) => task.targetFiles ?? []);
  if (!files.length) return false;
  return files.every((file) => !existsSync(path.resolve(projectPath, file)));
}

function codingStoppedMessage(
  error: StageError,
  taskId: string,
  index: number,
  allTaskIds: string[],
  completed: CompletedTask[],
): string {
  const notStarted = allTaskIds.slice(index + 1);
  return [
    `Coding stopped at task ${taskId} (${index + 1}/${allTaskIds.length}): ${error.message}`,
    "",
    `Finished before it: ${completed.map((t) => t.id).join(", ") || "(none)"} — that code is on disk, not reverted.`,
    `Not started: ${notStarted.join(", ") || "(none)"}.`,
    "",
    "Nothing was retried, so no further usage was spent. Progress is saved: fix the cause (for",
    `rate_limit, wait for the usage limit to reset) and run the same spec again — it resumes at ${taskId},`,
    "skipping the design and the finished tasks. Start fresh (--fresh) to redo everything.",
  ].join("\n");
}

function e2eFailedMessage(e2e: E2eVerdict): string {
  const uncovered = (e2e.acceptanceCriteria ?? [])
    .filter((ac) => !ac.covered)
    .map((ac) => `- ${ac.criterion} (${ac.evidence || "no evidence"})`);
  const failed = (e2e.failedScenarios ?? []).map((scenario) => `- ${scenario}`);
  return [
    "E2E/QA did not pass. The run stops here — the tasks are not re-coded automatically.",
    "",
    `Summary: ${e2e.summary}`,
    ...(failed.length ? ["", "Failed scenarios:", ...failed] : []),
    ...(uncovered.length ? ["", "Uncovered acceptance criteria:", ...uncovered] : []),
    "",
    "The code is on disk, not reverted. Fix what is listed above (or clarify the spec) and run again.",
    "Progress is saved: running the same spec again goes straight to E2E. Start fresh (--fresh) to",
    "redo everything.",
  ].join("\n");
}
