import { applySteps, type DbCheck, type ProposedStep, type StepOutcome } from "./sql-file.js";
import type { ProbeRun, SqlProbe } from "./sql-probe.js";

/**
 * Measured evidence for `aidev sql-optimize`: each step the model check and
 * the reference guard let through is run on a TEST database before it is
 * kept. The original runs once as the baseline; then, step by step, the code
 * with that step added runs the same test calls. A step is kept only when
 * every call returns exactly what the original returned (same result sets,
 * same rows in the same order, same values — or the same error). Everything
 * runs in transactions that are rolled back (`sql-probe.ts`).
 */

/** How a text is run: its definitions, then the calls — or, for a plain script, the script itself. */
export interface TestPlan {
  setupOf(text: string): string;
  callsOf(text: string): string[];
  describe: string;
}

const DEFINES_ROUTINES = /\bCREATE\s+(OR\s+(ALTER|REPLACE)\s+)?(PROC(EDURE)?|FUNCTION|VIEW|TRIGGER)\b|\bALTER\s+(PROC(EDURE)?|FUNCTION|VIEW)\b/i;

/**
 * A file that defines procedures/functions/views needs calls to exercise them;
 * a plain script is its own test. Null with a reason when there is nothing to run.
 */
export function testPlanFor(sql: string, calls: string[]): TestPlan | { skip: string } {
  if (DEFINES_ROUTINES.test(sql)) {
    if (!calls.length) {
      return { skip: "the file defines procedures/functions — give test calls (e.g. EXEC dbo.usp_X @Year = 2024) to compare results" };
    }
    return { setupOf: (text) => text, callsOf: () => calls, describe: `${calls.length} test call(s) against the file's definitions` };
  }
  return { setupOf: () => "", callsOf: (text) => [text], describe: "the script itself" };
}

/** Test calls from free text: one per line, blank lines and `--` comment lines ignored. */
export function parseTestCalls(text: string | undefined): string[] {
  return (text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("--"));
}

const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/**
 * A step that makes the calls clearly slower is no optimization. Under 20% (or
 * 5 ms) is taken as measurement noise: a few repetitions on a shared machine
 * vary that much.
 */
export function isSlower(msBefore: number, msAfter: number): boolean {
  return msAfter - msBefore > Math.max(5, msBefore * 0.2);
}

export function totalMs(run: ProbeRun): number {
  return Math.round(run.calls.reduce((sum, call) => sum + median(call.ms), 0) * 10) / 10;
}

/** Whether two runs are the same outcome, and if not, the first difference in words. */
export function compareRuns(base: ProbeRun, next: ProbeRun): { same: boolean; detail: string } {
  if (next.setupError) return { same: false, detail: `the definitions no longer run: ${next.setupError}` };
  for (const [i, call] of base.calls.entries()) {
    const other = next.calls[i];
    const label = `call ${i + 1}`;
    if (!other) return { same: false, detail: `${label} did not run` };
    if (call.error || other.error) {
      if (call.error === other.error) continue;
      return { same: false, detail: `${label}: ${call.error ? `original failed (${call.error})` : "original ran"}, now ${other.error ? `fails (${other.error})` : "runs"}` };
    }
    if (call.resultSets.length !== other.resultSets.length) {
      return { same: false, detail: `${label}: ${call.resultSets.length} result set(s) before, ${other.resultSets.length} now` };
    }
    for (const [s, set] of call.resultSets.entries()) {
      const now = other.resultSets[s];
      if (JSON.stringify(set) === JSON.stringify(now)) continue;
      if (set.length !== now.length) return { same: false, detail: `${label}, result set ${s + 1}: ${set.length} row(s) before, ${now.length} now` };
      const sorted = (rows: unknown[][]) => rows.map((row) => JSON.stringify(row)).sort().join("\n");
      if (sorted(set) === sorted(now)) return { same: false, detail: `${label}, result set ${s + 1}: same rows in a different order` };
      return { same: false, detail: `${label}, result set ${s + 1}: different values (same row count, ${set.length})` };
    }
  }
  return { same: true, detail: `${base.calls.length} call(s): identical results` };
}

/**
 * Applies the steps one at a time, keeping each only when the test database
 * gives the original's results with it. A later step written on top of a
 * dropped one may then no longer find its code — it is rejected, not guessed.
 */
export async function applyStepsVerified(opts: {
  /** The text the steps edit: the whole file, or one part of it (see `wrap`). */
  original: string;
  steps: (ProposedStep & { index: number; check?: StepOutcome["check"] })[];
  rejectedUpFront: Map<number, string>;
  probe: SqlProbe;
  plan: TestPlan;
  repeats: number;
  onProgress: (message: string) => void;
  /** For one part of a split file: the whole file with this part's text in place. The database always runs the whole file. */
  wrap?: (part: string) => string;
  /** The original's run, when an earlier part already made it; compared against, never re-run. */
  baseline?: ProbeRun;
  /** The time of the file as the earlier parts left it, for this part's first step. */
  startMs?: number;
  /** Read-only lines around a part, so the reference guard sees its declarations. */
  guardContext?: string;
}): Promise<{ text: string; outcomes: StepOutcome[]; baseline: ProbeRun; baselineMs: number; keptMs: number; baselineError?: string }> {
  const { original, steps, rejectedUpFront, probe, plan, repeats, onProgress, wrap = (part) => part, guardContext = "" } = opts;
  const run = (text: string) => {
    const whole = wrap(text);
    return probe.runRolledBack(plan.setupOf(whole), plan.callsOf(whole), repeats);
  };

  let baseline = opts.baseline;
  if (!baseline) {
    onProgress(`SQL verify: baseline — running the original on the test database (${plan.describe}, rolled back)`);
    baseline = await run(original);
    if (!baseline.setupError) onProgress(`SQL verify: baseline ${totalMs(baseline)} ms`);
  }
  if (baseline.setupError) {
    const { text, outcomes } = applySteps(original, steps, rejectedUpFront, guardContext);
    return { text, outcomes, baseline, baselineMs: 0, keptMs: 0, baselineError: baseline.setupError };
  }
  let keptText = original;
  let keptMs = opts.startMs ?? totalMs(baseline);

  const outcomes: StepOutcome[] = [];
  for (const step of steps) {
    const { text: candidate, outcomes: [outcome] } = applySteps(keptText, [step], rejectedUpFront, guardContext);
    if (outcome.status === "rejected") {
      outcomes.push(outcome);
      continue;
    }
    const next = await run(candidate);
    const { same, detail } = compareRuns(baseline, next);
    const db: DbCheck = { verdict: same ? "identical" : "differs", detail, msBefore: keptMs, msAfter: totalMs(next) };
    if (!same) {
      onProgress(`SQL verify: step ${step.index} — results DIFFER, not applied (${detail})`);
      outcomes.push({ ...outcome, status: "rejected", lines: undefined, rejectedBecause: `the test database gave different results: ${detail}`, db });
      continue;
    }
    if (isSlower(db.msBefore, db.msAfter)) {
      onProgress(`SQL verify: step ${step.index} — same results but slower, not applied (${db.msBefore} → ${db.msAfter} ms)`);
      outcomes.push({ ...outcome, status: "rejected", lines: undefined, rejectedBecause: `measured slower on the test database (${db.msBefore} → ${db.msAfter} ms)`, db });
      continue;
    }
    onProgress(`SQL verify: step ${step.index} — identical results, ${db.msBefore} → ${db.msAfter} ms`);
    keptText = candidate;
    keptMs = db.msAfter;
    outcomes.push({ ...outcome, db });
  }
  return { text: keptText, outcomes, baseline, baselineMs: totalMs(baseline), keptMs };
}
