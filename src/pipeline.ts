import { existsSync, readdirSync, type Dirent } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { businessQuestionsOf, runSpecsArch } from "./stages/specs-arch.js";
import { reviewSpecs } from "./stages/orchestrator-review.js";
import { inventoryReferences } from "./stages/reference-inventory.js";
import { cachedStage, repoVersions } from "./stage-cache.js";
import { inventoryProjectContext } from "./stages/project-context.js";
import { breakDownTasks } from "./stages/task-breakdown.js";
import { runCoding } from "./stages/coding.js";
import { isActiveStep, StepJournal, type ActiveStep } from "./step-session.js";
import { refreshProjectIndexes, taskLocations } from "./project-index.js";
import {
  manifestKeyOf,
  rememberConventions,
  rememberE2eRecipe,
  rememberFeatureStatus,
  rememberTask,
  reusableConventions,
  specIdentity,
} from "./project-memory.js";
import { runE2eTest } from "./stages/e2e-test.js";
import { clearCheckpoint, fingerprint, loadCheckpoint, progressKeptMessage, saveCheckpoint } from "./checkpoint.js";
import { findFreePorts } from "./free-ports.js";
import { metadataStandardsFingerprint } from "./metadata-standards.js";
import { skillCatalogFingerprint } from "./skills-catalog.js";
import { StageError } from "./stage-error.js";
import { RunBudgetError } from "./run-budget.js";
import { reportStep } from "./step-activity.js";
import {
  describeGateFailure,
  runVerifyGate,
  usableVerifyCommands,
  type GateResult,
  type VerifyCommand,
} from "./verify-gate.js";
import { rootsOf, type ProjectRoot } from "./target-roots.js";
import { applyNewScripts, snapshotScripts, type SqlScriptState } from "./database-scripts.js";
import type { SqlRunner } from "./database.js";
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
  status: "done" | "escalated-specs" | "escalated-e2e" | "errored" | "progress-kept" | "budget-stopped" | "needs-answers";
  message: string;
  logPath?: string;
}

export interface PipelineOptions {
  spec: SpecInput;
  onProgress?: (message: string) => void;
  logger?: RunLogger;
  /** Discard any progress saved by a stopped run and start from the beginning. */
  fresh?: boolean;
  /**
   * An open connection to the user's database, when one was given. The
   * scripts each task writes into `spec.database.scriptsDir` are applied
   * through it right after that task. The caller opens and closes it, so the
   * connection string itself never enters the pipeline.
   */
  sqlRunner?: SqlRunner;
  /**
   * The person's answers to the business questions a stopped run asked (see
   * `businessQuestionsOf`). Not part of the fingerprint: answering resumes
   * the saved design instead of discarding it.
   */
  answers?: string;
}

/**
 * Saved before the project scan starts, so a run killed during the scan
 * resumes the scan's own agent session instead of scanning from nothing.
 */
export interface ScanCheckpoint {
  phase: "scan";
  activeStep?: ActiveStep;
}

/**
 * Saved while the design is still under review: after the project scan, after
 * a proposal is written, after a rejected round and once it is approved — so a
 * run stopped or killed at any point picks up at the step it was in (see
 * `step-session.ts`), and a rejected design is revised, not redone.
 */
export interface DesignCheckpoint {
  phase: "design";
  inventory: ReferenceInventory | null;
  projectContext: ProjectContext | null;
  /** The last rejected proposal; null while none has been rejected. */
  lastProposal: string | null;
  lastFeedback: string | null;
  /** A proposal written but not reviewed yet. */
  draft?: string;
  /** The approved design, amendments included, when only the breakdown is left. */
  approved?: string;
  /** The design step whose agent session was running when this was saved. */
  activeStep?: ActiveStep;
}

/**
 * Saved once the design is approved: the plan and the tasks already finished.
 * Written after the breakdown, before and after every task, and before E2E.
 */
export interface BuildCheckpoint {
  phase: "build";
  inventory: ReferenceInventory | null;
  projectContext: ProjectContext | null;
  approvedProposal: string;
  tasks: TaskItem[];
  completedTasks: CompletedTask[];
  /** The Coding task or E2E step whose agent session was running when this was saved. */
  activeStep?: ActiveStep;
  /** Which SQL scripts were already there, and which this run applied (database runs only). */
  sqlScripts?: SqlScriptState;
  /**
   * Whether the build check passed before the first task this plan coded. A
   * project that already failed it gets no per-task check: new errors could
   * not be told from old ones.
   */
  verifyBaseline?: "pass" | "fail";
  /** The build check that failed after a task; that task's next session is shown it. */
  gateFailure?: { taskId: string; report: string };
}

/** Everything a stopped run leaves for the next one (see `checkpoint.ts`). */
export type FeatureCheckpoint = ScanCheckpoint | DesignCheckpoint | BuildCheckpoint;

type RunOutcome = Omit<PipelineResult, "logPath">;

export async function runPipeline(opts: PipelineOptions): Promise<PipelineResult> {
  try {
    const result = await runPipelineInner(opts);
    if (opts.spec.projectMemory && result.status !== "progress-kept") {
      await bestEffort(() => rememberFeatureStatus(rootsOf(opts.spec), specIdentity(opts.spec.specMarkdown), result.status));
    }
    opts.logger?.finish(result.status, result.message);
    const logPath = await opts.logger?.write();
    return { ...result, logPath };
  } catch (error) {
    if (error instanceof RunBudgetError) {
      opts.logger?.finish("budget-stopped", error.message);
      const logPath = await opts.logger?.write();
      return { status: "budget-stopped", message: error.message, logPath };
    }
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
  const journal = new StepJournal(plan.activeStep);
  let verifyBaseline = plan.verifyBaseline;
  let gateFailure = plan.gateFailure;
  // A plan saved before this run had a database has no baseline yet: what is
  // in the folder now counts as already there.
  const sqlScripts =
    opts.sqlRunner && spec.database
      ? (plan.sqlScripts ?? { baseline: await snapshotScripts(spec.database.scriptsDir), applied: {} })
      : undefined;
  const saveProgress = (activeStep: ActiveStep | undefined = journal.unfinished) =>
    saveCheckpoint<FeatureCheckpoint>("feature", spec.projectPath, checkpointKey, {
      phase: "build",
      inventory,
      projectContext,
      approvedProposal,
      tasks,
      completedTasks: [...completedTasks],
      ...(activeStep ? { activeStep } : {}),
      ...(sqlScripts ? { sqlScripts } : {}),
      ...(verifyBaseline ? { verifyBaseline } : {}),
      ...(gateFailure ? { gateFailure } : {}),
    });
  // Runs whatever new scripts are in the SQL folder. Called after every task,
  // so the next task and E2E find the tables in place, and once more before
  // E2E for a resumed run whose last task wrote scripts that never ran.
  const applyScripts = async () => {
    if (!opts.sqlRunner || !spec.database || !sqlScripts) return;
    await applyNewScripts({
      dir: spec.database.scriptsDir,
      state: sqlScripts,
      runner: opts.sqlRunner,
      onProgress,
      save: () => saveProgress(),
    });
  };
  // Saved before any task runs: a run killed mid-task must not resume with
  // that task's half-written scripts counted as the baseline.
  if (sqlScripts && !plan.sqlScripts) await saveProgress();

  reportStep({
    phase: "plan",
    group: "coding",
    items: tasks.map((task) => ({ id: task.id, label: headlineOf(task.description) })),
  });

  // --- The build check run after each task (verify-gate.ts) ---
  // Plain code, judged by exit code. First a baseline on the code as it is
  // before the next task, so a project that already fails is reported once
  // instead of failing every task.
  const gateCommands = await (async (): Promise<VerifyCommand[]> => {
    if (!config.verifyGate.enabled) return [];
    const { usable, refused } = usableVerifyCommands(projectContext?.verifyCommands, rootsOf(spec));
    for (const { command, reason } of refused) onProgress(`Build check: not running "${command}" — ${reason}`);
    if (!usable.length) {
      onProgress("Build check: skipped — no compile/lint command is known for this project");
      return [];
    }
    if (!verifyBaseline) {
      onProgress(`Build check: baseline — ${usable.length} command(s) on the code before the next task`);
      const baseline = await runGateStep("gate:baseline", usable);
      verifyBaseline = baseline.ok ? "pass" : "fail";
      await saveProgress();
    }
    if (verifyBaseline === "fail") {
      onProgress(
        "Build check: off for this run — the project already failed it before the next task, so new errors could not be told from old ones",
      );
      return [];
    }
    onProgress(`Build check: on — ${usable.map((entry) => entry.command).join(", ")}`);
    return usable;
  })();

  // --- Coding, once per task, then E2E/QA once ---
  // One pass only, by design. The earlier loop re-coded every task from the
  // first one after an E2E failure — on a real 8-task run that re-spent the
  // whole coding budget, hit the account's usage limit and crashed. A failure
  // now stops the run and says exactly where, so a person decides what next;
  // the checkpoint lets the next run carry on from that point.
  for (const [index, task] of tasks.entries()) {
    if (completedTasks.some((done) => done.id === task.id)) continue;

    let summary = "";
    let taskSession: ActiveStep | undefined;
    // Rounds after a failed build check, off by default (config.verifyGate.fixRounds):
    // each one costs a resumed Coding session, which is the person's call to pay for.
    for (let round = 0; ; round++) {
    try {
      // An interrupted task resumes its own saved session; when that
      // transcript is gone it starts a new one told to continue from the files
      // already on disk.
      const persist = (active: ActiveStep) => {
        taskSession = active;
        return saveProgress(active);
      };
      summary = await journal.run(`coding:${task.id}`, persist, async ({ interrupted, resumed }) => {
        const resumeNote = resumed
          ? " — resuming the interrupted session"
          : interrupted
            ? " — continuing the interrupted attempt from the files on disk"
            : "";
        onProgress(`Coding: ${task.id} (${index + 1}/${tasks.length})${resumeNote}`);
        const locations = await locateTask(spec, task, onProgress);
        return runCoding({
          spec,
          task,
          approvedProposal,
          completedTasks: [...completedTasks],
          inventory,
          projectContext,
          interrupted: interrupted && !resumed,
          ...(locations.length ? { locations } : {}),
          ...(gateFailure?.taskId === task.id ? { buildCheckFailure: gateFailure.report } : {}),
        });
      });
    } catch (error) {
      // The run budget is not this task's failure: it stops the whole run (see runPipeline).
      if (!(error instanceof StageError) || error instanceof RunBudgetError) throw error;
      return {
        status: "errored",
        message: codingStoppedMessage(error, task.id, index, tasks.map((t) => t.id), completedTasks),
      };
    }
    logger?.recordCoding(1, task.id, summary);
    if (gateCommands.length) {
      onProgress(`Build check: ${task.id} — running ${gateCommands.length} command(s)`);
      const result = await runGateStep(`gate:${task.id}`, gateCommands);
      if (!result.ok && result.failure) {
        const report = describeGateFailure(result.failure);
        gateFailure = { taskId: task.id, report };
        // The task's own session stays the active step: the next run resumes
        // it, with this failure in front of it, instead of moving on.
        await saveProgress(taskSession);
        onProgress(`Build check: fail — ${task.id}`);
        logger?.recordCoding(1, task.id, `Build check failed after this task:\n${report}`);
        if (taskSession && round < config.verifyGate.fixRounds) {
          onProgress(
            `Build check: fix round ${round + 1}/${config.verifyGate.fixRounds} — ${task.id} resumes its session with the failure`,
          );
          journal.offer(taskSession);
          continue;
        }
        return {
          status: "errored",
          message: gateFailedMessage(task.id, index, tasks.map((t) => t.id), completedTasks, report),
        };
      }
      onProgress(`Build check: pass — ${task.id}`);
      gateFailure = undefined;
    }
    break;
    }
    const files = await filesWrittenByTask(spec);
    completedTasks.push({ id: task.id, description: task.description, summary, ...(files.length ? { files } : {}) });
    await saveProgress();
    if (spec.projectMemory) {
      const recorded = files.length ? files : (task.targetFiles ?? []);
      const done = { id: task.id, summary, ...(recorded.length ? { files: recorded } : {}) };
      await bestEffort(() => rememberTask(rootsOf(spec), specIdentity(spec.specMarkdown), done));
    }
    await applyScripts();
  }

  await applyScripts();
  onProgress("E2E/QA: running");
  const e2e = await journal.run("e2e", saveProgress, async () =>
    runE2eTest(spec, approvedProposal, projectContext, await findFreePorts(), {
      // A run without a logger (tests, embedding) still needs somewhere to put the evidence.
      evidenceDir: logger?.evidenceDir ?? path.join(tmpdir(), `aidev-e2e-evidence-${Date.now()}`),
      onProgress,
    }),
  );
  // A finished E2E is not an interrupted one: re-running after a failed verdict
  // starts a fresh check of the code as it is then, not the old session.
  await saveProgress();
  if (e2e.check) {
    onProgress(
      e2e.check.ran
        ? `E2E/QA check: ${e2e.check.passed}/${e2e.check.total} passed, ${e2e.check.apiProblems.length} API problem(s), ${e2e.check.unguardedTests.length} unguarded test(s)`
        : "E2E/QA check: the pipeline's own Playwright run did not complete",
    );
  }
  logger?.recordE2e(1, e2e);
  onProgress(`E2E/QA verdict: ${e2e.verdict}`);

  if (e2e.verdict !== "pass") {
    return { status: "escalated-e2e", message: e2eFailedMessage(e2e) };
  }
  // Only a start-up the pipeline's own re-run confirmed is worth handing to the next run.
  const recipe = e2e.runRecipe;
  if (spec.projectMemory && recipe) await bestEffort(() => rememberE2eRecipe(rootsOf(spec), recipe));

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
  if (saved.status === "none") return planFromScratch(opts, checkpointKey, null);
  // Each step runs once: saved progress is never redone or overwritten unless
  // the person asks for it with --fresh (see checkpoint.ts).
  const keep = (reason: string): RunOutcome => {
    onProgress(`Resume: ${reason} — stopped, saved progress kept (start fresh to discard it)`);
    return { status: "progress-kept", message: progressKeptMessage(reason, saved.savedAt, FEATURE_INPUTS) };
  };
  if (saved.status === "stale") return keep("it was saved for different inputs than this run");

  if (isBuildCheckpoint(saved.data)) {
    if (finishedCodeIsGone(saved.data, rootsOf(spec))) {
      return keep("none of the files the finished tasks wrote are on disk any more");
    }
    return resumeBuild(opts, saved.data, saved.savedAt);
  }

  if (isDesignCheckpoint(saved.data)) {
    const design = saved.data;
    const where = design.approved
      ? "breaking the approved design into tasks"
      : design.draft
        ? "reviewing the proposal already written"
        : design.lastProposal
          ? "revising the last proposal with the reviewer's feedback"
          : "reusing the project scan";
    onProgress(`Resume: continuing the design stopped at ${saved.savedAt} — ${where} (start fresh to redo everything)`);
    return planFromScratch(opts, checkpointKey, design);
  }

  if (isScanCheckpoint(saved.data)) {
    onProgress(`Resume: continuing the project scan stopped at ${saved.savedAt} (start fresh to redo everything)`);
    return planFromScratch(opts, checkpointKey, null, saved.data.activeStep);
  }

  return keep("it is unreadable");
}

function needsAnswersMessage(questions: string[]): string {
  return [
    "The design needs business decisions that the spec and the code do not settle:",
    ...questions.map((question, index) => `${index + 1}. ${question}`),
    "",
    "Answer them and run again with the same spec — in the UI in the field \"Trả lời câu hỏi nghiệp vụ\",",
    'on the CLI with --answers "<text>". The design so far is saved: the answers revise it, nothing starts over.',
  ].join("\n");
}

function answersFeedback(questions: string[], answers: string): string {
  return [
    "You asked these business questions:",
    ...questions.map((question, index) => `${index + 1}. ${question}`),
    "",
    "The person answered:",
    answers,
    "",
    "Revise the proposal with these answers. Do not ask them again; ask only what they leave open.",
  ].join("\n");
}

/** Enough to name what a task wrote; a task touching more is listed up to this. */
const MAX_FILES_PER_TASK = 60;

/**
 * What a coding task wrote, read back by plain code: the project index is
 * refreshed right after the task, and what changed since the previous refresh
 * is that task's work. Only when the run has indexes (the CLI); empty when the
 * refresh fails — the task summary still says what it did.
 */
async function filesWrittenByTask(spec: SpecInput): Promise<string[]> {
  if (!spec.projectIndexes?.length) return [];
  try {
    const repos = await refreshProjectIndexes(rootsOf(spec).map((root) => root.path));
    return repos
      .flatMap((repo) => repo.changedLines.map((line) => `${path.basename(repo.repoRoot)}/${line}`))
      .slice(0, MAX_FILES_PER_TASK);
  } catch (error) {
    console.error("Project index refresh after a task failed:", error);
    return [];
  }
}

/**
 * Before a task: asks git what changed since the index was last refreshed,
 * re-indexes exactly that, then reads from the index where the task's code
 * goes. Edits made outside the run since the last task are picked up here,
 * and the refresh after the task then holds only that task's own files.
 * Best effort, like every index step: an empty list leaves the agent to Grep
 * the index itself.
 */
async function locateTask(spec: SpecInput, task: TaskItem, onProgress: (message: string) => void): Promise<string[]> {
  if (!spec.projectIndexes?.length) return [];
  try {
    const repos = await refreshProjectIndexes(rootsOf(spec).map((root) => root.path));
    const changed = repos.reduce((sum, repo) => sum + repo.changedFiles, 0);
    onProgress(
      changed
        ? `Project index: ${task.id} — git shows ${changed} changed file(s) since the last check, re-indexed`
        : `Project index: ${task.id} — no changes in git since the last check`,
    );
    return await taskLocations(repos, task.targetFiles ?? [], task.description);
  } catch (error) {
    console.error("Project index check before a task failed:", error);
    return [];
  }
}

/**
 * The project map is a convenience for later runs: failing to write it must
 * never fail the run that produced the work.
 */
async function bestEffort(write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (error) {
    console.error("Project map update failed:", error);
  }
}

/** What `featureFingerprint` is made of, in words, for `progressKeptMessage`. */
const FEATURE_INPUTS =
  "the spec text, the database option and engine, the reference repos, the target folders, the metadata standards and the installed skill catalog";

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
 * Scans (or reuses a saved scan), runs the design/review round, and breaks
 * the approved design into tasks. `start` is a saved design checkpoint to
 * continue from, or null for a clean start; `scanStep` is the scan step a
 * killed run left running, when it died during the scan.
 */
async function planFromScratch(
  opts: PipelineOptions,
  checkpointKey: string,
  start: DesignCheckpoint | null,
  scanStep?: ActiveStep,
): Promise<BuildCheckpoint | RunOutcome> {
  const { spec, onProgress = () => {}, logger } = opts;
  const journal = new StepJournal(start ? start.activeStep : scanStep);

  let inventory: ReferenceInventory | null;
  let projectContext: ProjectContext | null;

  if (start) {
    ({ inventory, projectContext } = start);
    onProgress("Reference inventory: reused from the stopped run");
  } else {
    const saveScan = (activeStep: ActiveStep | undefined = journal.unfinished) =>
      saveCheckpoint<FeatureCheckpoint>("feature", spec.projectPath, checkpointKey, {
        phase: "scan",
        ...(activeStep ? { activeStep } : {}),
      });
    // Saved before the scan, so a run killed mid-scan resumes the scan's session.
    if (!scanStep) await saveScan();
    ({ inventory, projectContext } = await scanInputs(opts, journal, saveScan));
  }
  logger?.recordReferenceInventory(inventory);
  logger?.recordProjectContext(projectContext);

  // A resumed design continues from exactly where it stopped: an approved
  // design goes straight to the breakdown, an unreviewed proposal straight to
  // review, and a rejected one is revised with the feedback it got.
  let lastProposal: string | null = start?.lastProposal ?? null;
  let lastFeedback: string | null = start?.lastFeedback ?? null;
  let draft: string | undefined = start?.draft;
  let approvedProposal: string | null = start?.approved ?? null;

  const saveDesign = (activeStep: ActiveStep | undefined = journal.unfinished) =>
    saveCheckpoint<FeatureCheckpoint>("feature", spec.projectPath, checkpointKey, {
      phase: "design",
      inventory,
      projectContext,
      lastProposal,
      lastFeedback,
      ...(draft !== undefined ? { draft } : {}),
      ...(approvedProposal !== null ? { approved: approvedProposal } : {}),
      ...(activeStep ? { activeStep } : {}),
    });
  // Saved before any design work, so a run killed during the first proposal
  // does not pay for the project scan again.
  if (!start) await saveDesign();

  // --- Specs & Arch <-> Orchestrator review ---
  // Answers revise the proposal once per run; a revision that still asks stops again.
  let answersApplied = false;
  if (approvedProposal === null) {
    for (let attempt = 1; attempt <= config.maxSpecAttempts; attempt++) {
      onProgress(`Specs & Arch: attempt ${attempt}/${config.maxSpecAttempts}`);
      if (draft === undefined) {
        const prior = lastProposal;
        const priorFeedback = lastFeedback ?? undefined;
        draft = await journal.run("design:specs-arch", saveDesign, () =>
          runSpecsArch(spec, prior, priorFeedback, inventory, projectContext),
        );
        await saveDesign();
      } else {
        onProgress("Specs & Arch: reused the proposal written before the interruption");
      }
      const proposal = draft;
      logger?.recordSpecsArch(attempt, proposal);
      const questions = businessQuestionsOf(proposal);
      if (questions.length) {
        const answers = opts.answers?.trim();
        if (!answers || answersApplied) {
          // The proposal stays saved as the draft: answered, it is revised, not redone.
          await saveDesign();
          onProgress(`Specs & Arch: stopped — ${questions.length} business question(s) need your answer`);
          return { status: "needs-answers", message: needsAnswersMessage(questions) };
        }
        answersApplied = true;
        onProgress(`Specs & Arch: revising the proposal with your answers to ${questions.length} business question(s)`);
        lastProposal = proposal;
        lastFeedback = answersFeedback(questions, answers);
        draft = undefined;
        await saveDesign();
        // Answering is not a rejected round: it does not use up an attempt.
        attempt--;
        continue;
      }
      const review = await journal.run("design:review", saveDesign, () => reviewSpecs(spec, proposal));
      logger?.recordReview(attempt, review);
      onProgress(`Orchestrator review: ${review.decision}`);
      draft = undefined;
      if (review.decision === "approve") {
        const amendments = (review.amendments ?? []).map((amendment) => amendment.trim()).filter(Boolean);
        if (amendments.length) {
          onProgress(`Orchestrator review: approved with ${amendments.length} amendment(s) for the coding stage`);
        }
        approvedProposal = withAmendments(proposal, amendments);
        await saveDesign();
        break;
      }
      lastProposal = proposal;
      lastFeedback = review.feedback;
      await saveDesign();
    }
  } else {
    onProgress("Specs & Arch: reused the approved design from the stopped run");
    onProgress("Orchestrator review: approve (from the stopped run)");
    logger?.recordSpecsArch(1, approvedProposal);
    logger?.recordReview(1, { decision: "approve", feedback: "Reused from the stopped run." });
  }

  if (approvedProposal === null) {
    return {
      status: "escalated-specs",
      message: [
        `Design proposal not approved (${config.maxSpecAttempts} round(s) per run — the run does not loop on its own).`,
        "",
        "Last proposal:",
        lastProposal ?? "(none)",
        "",
        "Last reviewer feedback:",
        lastFeedback ?? "(none)",
        "",
        "Progress is saved: running the same spec again revises this last proposal with the feedback",
        "above. If the feedback shows the spec itself is unclear, edit the spec and run with --fresh —",
        "that starts the design over.",
      ].join("\n"),
    };
  }

  // --- Task breakdown ---
  onProgress("Breaking approved design into tasks");
  const approved = approvedProposal;
  const { tasks } = await journal.run("design:breakdown", saveDesign, () =>
    breakDownTasks(spec, approved, inventory, projectContext),
  );
  logger?.recordTaskBreakdown(tasks);
  onProgress(`${tasks.length} task(s) to implement`);

  // Saved before any code is written: from here on, a stopped run costs the
  // next one nothing for design, review or breakdown.
  const plan: BuildCheckpoint = {
    phase: "build",
    inventory,
    projectContext,
    approvedProposal: approved,
    tasks,
    completedTasks: [],
  };
  await saveCheckpoint<FeatureCheckpoint>("feature", spec.projectPath, checkpointKey, plan);
  return plan;
}

async function scanInputs(
  opts: PipelineOptions,
  journal: StepJournal,
  saveScan: (activeStep: ActiveStep) => Promise<void>,
): Promise<{ inventory: ReferenceInventory | null; projectContext: ProjectContext | null }> {
  const { spec, onProgress = () => {}, fresh = false } = opts;
  const targetFolders = (spec.targetRoots ?? [{ path: spec.projectPath }]).map((root) => root.path);
  // An answer is reused only for the same spec against byte-identical repos
  // (git HEAD + uncommitted state, from the project index). Either changing
  // re-runs the stage.
  const reuseNote = (stage: string) => (savedAt: string) =>
    onProgress(`${stage}: reused from ${savedAt} — same spec, repositories unchanged since`);

  // --- Reference inventory (only when a sample project was given) ---
  let inventory: ReferenceInventory | null = null;
  if (spec.referencePaths?.length) {
    onProgress("Reference inventory: scanning the reference repositories");
    const versions = repoVersions(spec.projectIndexes, spec.referencePaths);
    inventory = await cachedStage({
      kind: "reference-inventory",
    project: spec.projectPath,
      key: versions && [spec.specMarkdown, versions],
      fresh,
      run: () => journal.run("scan:reference-inventory", saveScan, () => inventoryReferences(spec)),
      onHit: reuseNote("Reference inventory"),
    });
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
  // Conventions change only when the build does: while the build manifests are
  // the ones the project map read them under, they are reused without a scan
  // (see project-memory.ts). The relevant-files list is not kept — later stages
  // look files up in the project index instead.
  const roots = rootsOf(spec);
  const manifestKey = spec.projectMemory ? manifestKeyOf(spec.projectIndexes, roots) : null;
  const remembered = reusableConventions(spec.projectMemory, manifestKey);
  if (remembered) {
    onProgress("Project context: conventions reused from the project map — build files unchanged, no scan");
    return {
      inventory,
      projectContext: {
        conventions: remembered.text,
        relevantFiles: [],
        notes: "Conventions come from the project map. No relevant-file scan was run: find files through the project index.",
        verifyCommands: remembered.verifyCommands,
      },
    };
  }

  onProgress("Project context: scanning the target project");
  const targetVersions = repoVersions(spec.projectIndexes, targetFolders);
  const projectContext: ProjectContext | null = await cachedStage({
    kind: "project-context",
    project: spec.projectPath,
    key: targetVersions && [spec.specMarkdown, targetVersions],
    fresh,
    run: () => journal.run("scan:project-context", saveScan, () => inventoryProjectContext(spec)),
    onHit: reuseNote("Project context"),
  });
  onProgress(
    projectContext
      ? "Project context: conventions and relevant files gathered"
      : "Project context: unavailable — stages will explore the project themselves",
  );
  if (projectContext && manifestKey) {
    await bestEffort(() =>
      rememberConventions(roots, manifestKey, projectContext.conventions, projectContext.verifyCommands),
    );
  }

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
    // The scripts are written in this engine's syntax; another engine needs another design.
    // Appended only when present, so runs without a database keep their saved progress.
    ...(spec.database ? [spec.database.dialect] : []),
    [...(spec.referencePaths ?? [])].sort(),
    // Moving from one folder to separate BE/FE folders changes where every
    // planned file lives, so a plan saved for one layout does not carry over.
    rootsOf(spec).map((root) => `${root.role}:${root.path}`),
    // The design was reviewed against these rules; different rules need a new design.
    metadataStandardsFingerprint(spec.metadataStandards),
    // A design that routed to a skill (or could have) needs redoing if the catalog changed.
    skillCatalogFingerprint(spec.skillCatalog),
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

function isScanCheckpoint(data: unknown): data is ScanCheckpoint {
  const candidate = data as ScanCheckpoint;
  return candidate?.phase === "scan" && (candidate.activeStep === undefined || isActiveStep(candidate.activeStep));
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
function finishedCodeIsGone(data: BuildCheckpoint, roots: ProjectRoot[]): boolean {
  const doneIds = new Set(data.completedTasks.map((task) => task.id));
  const files = data.tasks
    .filter((task) => doneIds.has(task.id))
    .flatMap((task) => task.targetFiles ?? []);
  if (!files.length) return false;
  return !files.some((file) => fileIsOnDisk(file, roots));
}

/**
 * Whether a file a finished task named is on disk. Task paths come from a
 * model and are not reliably relative to the folder they live in — a split
 * project can get them prefixed with the folder ("BE/src/…"), or absolute.
 * Checked the strict way first, then without a leading folder name, and last
 * by file name anywhere under the roots. Erring towards "still there" is the
 * cheap side: a wrong "gone" throws away a whole plan and its finished tasks.
 */
function fileIsOnDisk(file: string, roots: ProjectRoot[]): boolean {
  const segments = file.replace(/\\/g, "/").split("/").filter(Boolean);
  const candidates = [file, segments.slice(1).join("/")].filter(Boolean);
  for (const root of roots) {
    if (candidates.some((candidate) => existsSync(path.resolve(root.path, candidate)))) return true;
  }
  const name = segments.at(-1);
  return name ? roots.some((root) => containsFileNamed(root.path, name)) : false;
}

const UNSEARCHED_DIRS = new Set(["node_modules", ".git", "target", "dist", "build", ".idea"]);

function containsFileNamed(dir: string, name: string): boolean {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name === name) return true;
    if (entry.isDirectory() && !UNSEARCHED_DIRS.has(entry.name) && containsFileNamed(path.join(dir, entry.name), name)) {
      return true;
    }
  }
  return false;
}

/** Runs the build check as a step the UI can draw: start, then an end that says whether it passed. */
async function runGateStep(step: string, commands: VerifyCommand[]): Promise<GateResult> {
  reportStep({ step, phase: "start" });
  const result = await runVerifyGate(commands, config.verifyGate);
  reportStep({ step, phase: "end", ok: result.ok });
  return result;
}

function gateFailedMessage(
  taskId: string,
  index: number,
  allTaskIds: string[],
  completed: CompletedTask[],
  report: string,
): string {
  return [
    `Build check failed after task ${taskId} (${index + 1}/${allTaskIds.length}). The pipeline ran the project's own check and it did not pass:`,
    "",
    report,
    "",
    `Finished before it: ${completed.map((t) => t.id).join(", ") || "(none)"} — that code is on disk, not reverted.`,
    `Not started: ${allTaskIds.slice(index + 1).join(", ") || "(none)"}.`,
    "",
    `Nothing was retried. Fix it by hand and run again, or just run again: the next run resumes task ${taskId}'s own session with this failure in front of it, and moves on only once the check passes.`,
  ].join("\n");
}

/** A task description's first line, for the UI's mind map. */
function headlineOf(description: string): string {
  const first = description.trim().split("\n")[0] ?? "";
  return first.length <= 120 ? first : `${first.slice(0, 120)}…`;
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
