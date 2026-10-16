import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { canResumeSession } from "./sdk-helpers.js";
import { assertRunBudget } from "./run-budget.js";
import { withStepActivity } from "./step-activity.js";

/**
 * Lets every agent step of a pipeline survive the process dying mid-step —
 * the machine shut down, the UI server stopped, a usage limit.
 *
 * Before a step's agent session starts, its session id is saved in the run's
 * checkpoint as the `ActiveStep`. The SDK writes the session transcript as it
 * goes, so after a restart the same step resumes that very conversation
 * (verified by killing a session mid-tool-call and resuming it with its
 * context intact) instead of starting the step over. Finished steps are never
 * re-run: their results are in the checkpoint already.
 *
 * The session reaches `runQueryLoop` through AsyncLocalStorage rather than a
 * parameter on every stage, so the stages stay unaware of it; only the first
 * query a step makes is tied to the saved session (see `claimStepSession`).
 */

/** The step whose agent session was running when the checkpoint was saved. */
export interface ActiveStep {
  step: string;
  sessionId: string;
}

/** What a step's body learns about how it is being run. */
export interface StepRun {
  /** The step was running when the previous process died. */
  interrupted: boolean;
  /** ...and its saved session is being resumed, conversation and all. */
  resumed: boolean;
}

interface StepContext {
  sessionId: string;
  resume: boolean;
  claimed: boolean;
}

const current = new AsyncLocalStorage<StepContext>();

/**
 * The saved session for the query about to run, once per step. A stage that
 * makes a second query in the same step (a structured-output retry) gets a new,
 * untracked session for it: reusing the id would collide with the first.
 */
export function claimStepSession(): { sessionId: string; resume: boolean } | undefined {
  const context = current.getStore();
  if (!context || context.claimed) return undefined;
  context.claimed = true;
  return { sessionId: context.sessionId, resume: context.resume };
}

export class StepJournal {
  /**
   * @param pending the step saved as running by the process that died, if any;
   *   it is offered to the first step of the same name and then forgotten.
   */
  constructor(private pending: ActiveStep | undefined) {}

  /** Whether `step` was the one running when the previous process died. */
  wasInterrupted(step: string): boolean {
    return this.pending?.step === step;
  }

  /**
   * The interrupted step not yet picked up again. A checkpoint saved before
   * that step is reached must keep it, or a second interruption in between
   * would lose the session to resume.
   */
  get unfinished(): ActiveStep | undefined {
    return this.pending;
  }

  /**
   * Hands a step's own session back for its next `run` in this process — a
   * build-check fix round continues the task's conversation exactly as the
   * next run would after a stop.
   */
  offer(active: ActiveStep): void {
    this.pending = active;
  }

  /**
   * Runs one agent step. `persist` writes the checkpoint with the given active
   * step; it is called before the session starts, because a killed process
   * never gets to save anything afterwards. The caller's next save, once the
   * step's result is in hand, drops the active step again.
   */
  async run<T>(
    step: string,
    persist: (active: ActiveStep) => Promise<void>,
    body: (run: StepRun) => Promise<T>,
  ): Promise<T> {
    // Before anything is saved for this step: a run stopped by its budget must
    // leave the checkpoint exactly as the last finished step left it.
    assertRunBudget(step);
    const saved = this.pending?.step === step ? this.pending : undefined;
    if (saved) this.pending = undefined;
    const resume = !!saved && (await canResumeSession(saved.sessionId));
    const sessionId = resume && saved ? saved.sessionId : randomUUID();
    await persist({ step, sessionId });
    return withStepActivity(step, () =>
      current.run({ sessionId, resume, claimed: false }, () => body({ interrupted: !!saved, resumed: resume })),
    );
  }
}

/** Shape check for an `ActiveStep` read back from a checkpoint. */
export function isActiveStep(value: unknown): value is ActiveStep {
  const candidate = value as ActiveStep;
  return typeof candidate?.step === "string" && typeof candidate.sessionId === "string";
}
