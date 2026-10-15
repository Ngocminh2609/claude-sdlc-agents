import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Live, structured news about the pipeline's steps — which one is running, how
 * many of its turns it has used, how it ended — for a front end to draw (the
 * UI's mind map). Same process-wide listener pattern as `token-usage.ts`: the
 * CLI subscribes and turns each report into an event line.
 *
 * Steps are the names `StepJournal` already uses (`coding:T3`, `port:<group>`,
 * `verify:build:1`) plus the plain-code build check (`gate:T3`), so the UI and
 * the checkpoint speak about the same units of work.
 *
 * A turn count is not a completion measure — an agent can finish in 5 turns
 * or use all 60 — so the UI must present it as "turns used of the cap", never
 * as "percent done". Only a step's end is a real completion signal.
 */

export type StepNote = "repeat" | "blocked" | "soft-cap";

export interface StepActivity {
  step: string;
  phase: "start" | "turn" | "end";
  /** Agent turns used so far, and the stage's cap (phase "turn"). */
  turns?: number;
  maxTurns?: number;
  /** How the step ended (phase "end"). */
  ok?: boolean;
  /** A loop-guard intervention that happened on this turn. */
  note?: StepNote;
}

/**
 * The units of work a stage is about to go through — the tasks of a feature
 * run, the port groups of a clone run — so the UI can draw them before they
 * start. `id` is the part after the colon in the step names (`coding:T3`).
 */
export interface StepPlan {
  phase: "plan";
  group: "coding" | "port";
  items: { id: string; label: string }[];
}

export type StepReport = StepActivity | StepPlan;

const listeners = new Set<(report: StepReport) => void>();
const currentStep = new AsyncLocalStorage<string>();

export function reportStep(report: StepReport): void {
  for (const listener of listeners) listener(report);
}

/** Returns an unsubscribe function. */
export function onStepActivity(listener: (report: StepReport) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The step whose code is running now, for reports made deep inside it (the loop guard's hooks). */
export function activeStepName(): string | undefined {
  return currentStep.getStore();
}

/** Runs `body` as `step`: reports its start and end, and names it for `activeStepName`. */
export async function withStepActivity<T>(step: string, body: () => Promise<T>): Promise<T> {
  reportStep({ step, phase: "start" });
  try {
    const value = await currentStep.run(step, body);
    reportStep({ step, phase: "end", ok: true });
    return value;
  } catch (error) {
    reportStep({ step, phase: "end", ok: false });
    throw error;
  }
}

/** Tests only. */
export function resetStepActivity(): void {
  listeners.clear();
}
