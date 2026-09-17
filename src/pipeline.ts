import { config } from "./config.js";
import { runSpecsArch } from "./stages/specs-arch.js";
import { reviewSpecs } from "./stages/orchestrator-review.js";
import { inventoryReferences } from "./stages/reference-inventory.js";
import { breakDownTasks } from "./stages/task-breakdown.js";
import { runCoding } from "./stages/coding.js";
import { runE2eTest } from "./stages/e2e-test.js";
import type { RunLogger } from "./run-log.js";
import type { CompletedTask, E2eAttempt, ReferenceInventory, SpecInput } from "./types.js";

export interface PipelineResult {
  status: "done" | "escalated-specs" | "escalated-e2e" | "errored";
  message: string;
  logPath?: string;
}

export interface PipelineOptions {
  spec: SpecInput;
  onProgress?: (message: string) => void;
  logger?: RunLogger;
}

export async function runPipeline(opts: PipelineOptions): Promise<PipelineResult> {
  try {
    const result = await runPipelineInner(opts);
    opts.logger?.finish(result.status, result.message);
    const logPath = await opts.logger?.write();
    return { ...result, logPath };
  } catch (error) {
    console.error("Pipeline crashed:", error);
    const message = "An unexpected error occurred. Check the console output above for details.";
    opts.logger?.finish("errored", message);
    const logPath = await opts.logger?.write();
    return { status: "errored", message, logPath };
  }
}

async function runPipelineInner(opts: PipelineOptions): Promise<Omit<PipelineResult, "logPath">> {
  const { spec, onProgress = () => {}, logger } = opts;

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
  logger?.recordReferenceInventory(inventory);

  // --- Loop 1: Specs & Arch <-> Orchestrator review ---
  let proposal: string | null = null;
  let feedback: string | undefined;
  let approved = false;

  for (let attempt = 1; attempt <= config.maxSpecAttempts; attempt++) {
    onProgress(`Specs & Arch: attempt ${attempt}/${config.maxSpecAttempts}`);
    proposal = await runSpecsArch(spec, proposal, feedback, inventory);
    logger?.recordSpecsArch(attempt, proposal);
    const review = await reviewSpecs(spec, proposal);
    logger?.recordReview(attempt, review);
    onProgress(`Orchestrator review: ${review.decision}`);
    if (review.decision === "approve") {
      approved = true;
      break;
    }
    feedback = review.feedback;
  }

  if (!approved) {
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
      ].join("\n"),
    };
  }

  const approvedProposal = proposal as string;

  // --- Task breakdown ---
  onProgress("Breaking approved design into tasks");
  const { tasks } = await breakDownTasks(spec, approvedProposal, inventory);
  logger?.recordTaskBreakdown(tasks);
  onProgress(`${tasks.length} task(s) to implement`);

  // --- Loop 2: Coding & Unit Test (per task) <-> E2E/QA (whole feature) ---
  let e2eFeedback: string | undefined;
  let passed = false;
  const e2eHistory: E2eAttempt[] = [];

  for (let attempt = 1; attempt <= config.maxCodingAttempts; attempt++) {
    // Reset per attempt: a retry re-runs every task from the first one, so
    // "already implemented in this pass" starts empty again each time.
    const completedTasks: CompletedTask[] = [];

    for (const task of tasks) {
      onProgress(`Coding: ${task.id} (attempt ${attempt}/${config.maxCodingAttempts})`);
      const summary = await runCoding({
        spec,
        task,
        approvedProposal,
        completedTasks: [...completedTasks],
        inventory,
        priorE2eFeedback: e2eFeedback,
      });
      logger?.recordCoding(attempt, task.id, summary);
      completedTasks.push({ id: task.id, description: task.description, summary });
    }

    onProgress(`E2E/QA: running (attempt ${attempt}/${config.maxCodingAttempts})`);
    const e2e = await runE2eTest(spec, approvedProposal);
    logger?.recordE2e(attempt, e2e);
    e2eHistory.push({ ...e2e, attempt });
    onProgress(`E2E/QA verdict: ${e2e.verdict}`);

    if (e2e.verdict === "pass") {
      passed = true;
      break;
    }

    const uncovered = (e2e.acceptanceCriteria ?? [])
      .filter((ac) => !ac.covered)
      .map((ac) => `"${ac.criterion}" (${ac.evidence || "no evidence"})`);
    e2eFeedback = [
      e2e.summary,
      `Failed scenarios: ${(e2e.failedScenarios ?? []).join(", ") || "(none listed)"}`,
      uncovered.length ? `Uncovered acceptance criteria: ${uncovered.join("; ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (!passed) {
    return {
      status: "escalated-e2e",
      message: [
        `E2E/QA did not pass after ${config.maxCodingAttempts} attempts.`,
        "The code as-is is still on disk (not reverted) for you to inspect and finish by hand.",
        "",
        "E2E history:",
        ...e2eHistory.map((e) => `- attempt ${e.attempt}: ${e.verdict} — ${e.summary}`),
      ].join("\n"),
    };
  }

  return {
    status: "done",
    message: "E2E/QA passed. Review the changes in your working tree and commit when ready.",
  };
}
