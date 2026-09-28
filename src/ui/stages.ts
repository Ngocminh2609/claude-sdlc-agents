/**
 * Turns a pipeline progress message into the stage the UI should highlight.
 *
 * The messages themselves come from the `onProgress` calls in
 * `src/pipeline.ts` and `src/clone-pipeline.ts`; this file is the one place
 * that knows their wording. A message this file doesn't recognise is not an
 * error — the UI still shows it verbatim in the log and simply leaves the
 * stage strip where it was. That is the intended degradation if a message is
 * ever reworded: less highlighting, never a wrong verdict or a stalled UI.
 *
 * Stage ids only, no display names: what a stage is called on screen is the
 * front end's business (and the front end is Vietnamese), so every user-facing
 * string lives in `public/app.js` rather than being split across two layers.
 */

/** Building something new from a spec. */
export const FEATURE_STAGE_IDS = [
  "inventory",
  "specs-arch",
  "review",
  "tasks",
  "coding",
  "e2e",
] as const;

/** Porting an existing feature out of a reference repo. */
export const CLONE_STAGE_IDS = [
  "locate",
  "conventions",
  "mapping",
  "port",
  "coverage",
  "wiring",
  "build",
  "tests",
] as const;

export type RunMode = "feature" | "clone";

export type StageId = (typeof FEATURE_STAGE_IDS)[number] | (typeof CLONE_STAGE_IDS)[number];

export const STAGE_IDS_BY_MODE: Record<RunMode, readonly StageId[]> = {
  feature: FEATURE_STAGE_IDS,
  clone: CLONE_STAGE_IDS,
};

export function stageOfProgress(message: string): StageId | null {
  // Clone pipeline
  if (message.startsWith("Clone locate:")) return "locate";
  if (message.startsWith("Clone conventions:")) return "conventions";
  if (message.startsWith("Clone mapping:")) return "mapping";
  if (message.startsWith("Clone port:")) return "port";
  if (message.startsWith("Clone coverage:")) return "coverage";
  if (message.startsWith("Clone wiring:")) return "wiring";
  if (message.startsWith("Clone build:")) return "build";
  // A fix round belongs to the test stage: it exists to make build and tests pass.
  if (message.startsWith("Clone tests:") || message.startsWith("Clone fix:")) return "tests";

  // Feature pipeline
  if (message.startsWith("Reference inventory:")) return "inventory";
  if (message.startsWith("Specs & Arch:")) return "specs-arch";
  if (message.startsWith("Orchestrator review:")) return "review";
  if (message.startsWith("Breaking approved design")) return "tasks";
  if (/task\(s\) to implement$/.test(message)) return "tasks";
  if (message.startsWith("Coding:")) return "coding";
  if (message.startsWith("E2E/QA")) return "e2e";

  return null;
}

/** The task count from "N task(s) to implement", or null for other messages. */
export function taskCountOfProgress(message: string): number | null {
  const match = /^(\d+) task\(s\) to implement$/.exec(message);
  return match ? Number(match[1]) : null;
}

/**
 * Whether a progress message is a verdict the UI should show as a setback
 * rather than as progress. This only colors the strip: whether the run then
 * stops (a failed E2E ends a feature run) or carries on (a rejected design is
 * revised, a clone run reports the whole picture) is the pipeline's call, and
 * the final status says which.
 */
export function isSetbackProgress(message: string): boolean {
  return (
    message === "Orchestrator review: reject" ||
    message === "E2E/QA verdict: fail" ||
    message === "Clone build: fail" ||
    message.startsWith("Clone tests: fail") ||
    message.startsWith("Clone fix: round") ||
    message.startsWith("Clone mapping: warning") ||
    // Not fatal — the run continues — but it means the later stages lost the
    // file checklist, which is exactly the thing worth noticing on screen.
    message.startsWith("Reference inventory: unavailable") ||
    /^Clone coverage: \d+ file\(s\) missing$/.test(message) ||
    /^Clone wiring: \d+ problem\(s\)$/.test(message)
  );
}
