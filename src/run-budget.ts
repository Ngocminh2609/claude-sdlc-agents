import { StageError } from "./stage-error.js";
import { usageSoFar } from "./token-usage.js";

/**
 * An optional spend cap for a whole run (`--max-run-usd`), checked before each
 * agent step starts (`StepJournal.run`). Reaching it stops the run with status
 * `budget-stopped` and keeps every bit of progress: the next run — with a
 * higher cap or none — carries on from the step that did not start. Nothing is
 * retried or redone, in line with "every step runs once".
 *
 * Checked between steps, not inside one: a step that starts under the cap runs
 * to its end (its own `maxBudgetUsd` in `config.ts` bounds it), so the run can
 * finish somewhat above the cap. The SDK's figure is an estimate, not a bill.
 */

let capUsd: number | undefined;

export class RunBudgetError extends StageError {
  constructor(
    readonly spentUsd: number,
    readonly capUsd: number,
    readonly step: string,
  ) {
    super(
      `Run budget reached before "${step}": ~$${spentUsd.toFixed(2)} spent of the $${capUsd.toFixed(2)} cap. ` +
        "Progress is saved — run again with a higher cap (or none) to continue from this step.",
    );
    this.name = "RunBudgetError";
  }
}

/** Undefined, zero or a non-number means no cap. */
export function setRunBudget(usd: number | undefined): void {
  capUsd = usd !== undefined && Number.isFinite(usd) && usd > 0 ? usd : undefined;
}

export function runBudget(): number | undefined {
  return capUsd;
}

/** Throws `RunBudgetError` when the run has already spent its cap. */
export function assertRunBudget(step: string): void {
  if (capUsd === undefined) return;
  const spent = usageSoFar().costUsd;
  if (spent >= capUsd) throw new RunBudgetError(spent, capUsd, step);
}
