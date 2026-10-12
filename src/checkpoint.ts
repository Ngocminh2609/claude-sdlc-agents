import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Progress saved during a run, so a run that stops part-way — a failed task,
 * a usage limit, Stop in the UI, the process being killed for memory — picks
 * up where it left off the next time it is started, instead of paying again
 * for design, review, breakdown and every task that already finished.
 *
 * It is written after every step rather than at the end, because the end is
 * exactly what a killed process never reaches (the run log is only written
 * then, which is why a killed run used to leave nothing to resume from).
 *
 * One file per pipeline kind per target project, in this repo's `runs/` —
 * never in the target project. A fingerprint of the inputs that the saved
 * plan depends on (the spec text, the reference repos, ...) is stored with it:
 * change any of them and the saved progress no longer describes this run, so
 * it is reported as stale. A stale, unreadable or wiped-out checkpoint stops
 * the run (status `progress-kept`) instead of starting over: only `--fresh`
 * discards saved progress. Starting over on its own once re-planned and
 * re-coded two finished tasks of a real run because an input outside the spec
 * changed, and the next save overwrote the progress it threw away.
 *
 * Never holds a `--db-connection` value — callers leave it out of both the
 * data and the fingerprint.
 */

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECKPOINT_DIR = path.join(TOOL_ROOT, "runs");
const VERSION = 1;

export type CheckpointKind = "feature" | "clone";

interface StoredCheckpoint<T> {
  version: number;
  fingerprint: string;
  savedAt: string;
  data: T;
}

export type LoadedCheckpoint<T> =
  | { status: "none" }
  | { status: "stale"; savedAt: string }
  | { status: "found"; savedAt: string; data: T };

/** Stable hash of whatever inputs the saved plan was built from. */
export function fingerprint(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function checkpointPath(kind: CheckpointKind, projectPath: string): string {
  const resolved = path.resolve(projectPath);
  // Windows paths are case-insensitive: D:\App and d:\app are one project.
  const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return path.join(CHECKPOINT_DIR, `.checkpoint-${kind}-${hash}.json`);
}

export async function loadCheckpoint<T>(
  kind: CheckpointKind,
  projectPath: string,
  expectedFingerprint: string,
): Promise<LoadedCheckpoint<T>> {
  let stored: StoredCheckpoint<T>;
  try {
    stored = JSON.parse(await readFile(checkpointPath(kind, projectPath), "utf-8")) as StoredCheckpoint<T>;
  } catch {
    return { status: "none" }; // Missing or corrupt: nothing trustworthy to resume.
  }
  if (stored.version !== VERSION || typeof stored.data !== "object" || stored.data === null) {
    return { status: "none" };
  }
  if (stored.fingerprint !== expectedFingerprint) return { status: "stale", savedAt: stored.savedAt };
  return { status: "found", savedAt: stored.savedAt, data: stored.data };
}

/**
 * Written to a temp file and renamed into place, so a process killed mid-write
 * leaves the previous checkpoint rather than a half-written one.
 */
export async function saveCheckpoint<T>(
  kind: CheckpointKind,
  projectPath: string,
  checkpointFingerprint: string,
  data: T,
): Promise<void> {
  const target = checkpointPath(kind, projectPath);
  const stored: StoredCheckpoint<T> = {
    version: VERSION,
    fingerprint: checkpointFingerprint,
    savedAt: new Date().toISOString(),
    data,
  };
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp`;
  await writeFile(temp, JSON.stringify(stored, null, 2), "utf-8");
  await rename(temp, target);
}

/**
 * The message a run stops with when saved progress exists but cannot be
 * resumed. `reason` says what is wrong with it; `inputs` lists what this
 * pipeline's fingerprint is made of, so the person can undo the change instead
 * of throwing the progress away.
 */
export function progressKeptMessage(reason: string, savedAt: string, inputs: string): string {
  return [
    `Saved progress from ${savedAt} was found, but ${reason}.`,
    "",
    "The run stopped without doing anything, so no usage was spent and the saved progress is untouched.",
    `Either undo the change and run again to continue where it stopped (the progress depends on: ${inputs}),`,
    "or start fresh (--fresh) to discard it and redo everything from the beginning.",
  ].join("\n");
}

export async function clearCheckpoint(kind: CheckpointKind, projectPath: string): Promise<void> {
  await rm(checkpointPath(kind, projectPath), { force: true });
}
