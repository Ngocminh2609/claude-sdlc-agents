import { readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { isTokenUsage, type TokenUsage } from "../token-usage.js";
import { runsDir } from "./paths.js";
import type { RunMode } from "./stages.js";

/**
 * Read-only view over the `runs/` folder RunLogger writes.
 *
 * The folder on disk is the source of truth, not an in-memory index: runs
 * written by the CLI (outside any UI session) show up here too, which is the
 * whole point of browsing history in the UI.
 */

export interface RunSummary {
  id: string;
  startedAt: string | null;
  finishedAt: string | null;
  status: string;
  /** Which flow produced the run, so history can tell a port from a new feature. */
  mode: RunMode;
  projectPath: string | null;
  projectName: string | null;
  specName: string | null;
  taskCount: number;
  durationMs: number | null;
  /** Total tokens, when the run was started from the UI (it writes usage.json). */
  usage: TokenUsage | null;
}

export interface RunDetail extends RunSummary {
  finalMessage: string;
  report: string;
}

export class RunNotFoundError extends Error {
  constructor(id: string) {
    super(`No run named "${id}" under runs/.`);
    this.name = "RunNotFoundError";
  }
}

/**
 * Run ids are folder names that reach the filesystem, and they arrive from an
 * HTTP query string. Allow only the shape RunLogger produces
 * (`<iso-timestamp>-<project>-<spec>`), so no request can walk out of runs/.
 */
export function isValidRunId(id: string): boolean {
  return id.length > 0 && id.length <= 200 && /^[A-Za-z0-9._-]+$/.test(id) && !id.startsWith(".");
}

export async function listRuns(limit = 100): Promise<RunSummary[]> {
  let entries: string[];
  try {
    entries = (await readdir(runsDir, { withFileTypes: true }))
      // Dot-folders are caches (.project-index, .stage-cache), not runs.
      .filter((entry) => entry.isDirectory() && isValidRunId(entry.name))
      .map((entry) => entry.name);
  } catch {
    return []; // No runs/ folder yet — nothing has been run on this machine.
  }

  // The folder name starts with an ISO timestamp, so newest-first is a plain
  // reverse lexicographic sort — no need to stat or parse every log first.
  entries.sort().reverse();

  const summaries: RunSummary[] = [];
  for (const id of entries.slice(0, limit)) {
    summaries.push(await readSummary(id));
  }
  return summaries;
}

export async function readRun(id: string): Promise<RunDetail> {
  if (!isValidRunId(id)) throw new RunNotFoundError(id);
  const dir = path.join(runsDir, id);
  try {
    if (!(await stat(dir)).isDirectory()) throw new RunNotFoundError(id);
  } catch {
    throw new RunNotFoundError(id);
  }

  const summary = await readSummary(id);
  const log = await readLog(id);
  const report = await readFile(path.join(dir, "report.md"), "utf-8").catch(
    () => "_This run has no report.md — it was interrupted before the log was written._",
  );

  return {
    ...summary,
    finalMessage: typeof log?.finalMessage === "string" ? log.finalMessage : "",
    report,
  };
}

async function readSummary(id: string): Promise<RunSummary> {
  const log = await readLog(id);
  const startedAt = asString(log?.startedAt);
  const finishedAt = asString(log?.finishedAt);
  const projectPath = asString((log?.spec as Record<string, unknown> | undefined)?.projectPath);
  const mode = runModeOfLog(log, id);

  return {
    id,
    startedAt,
    finishedAt,
    // "unknown" rather than a guess: a run killed mid-flight never wrote a log.
    status: asString(log?.finalStatus) ?? "unknown",
    mode,
    projectPath,
    projectName: projectPath ? path.basename(projectPath) : null,
    // A clone run is named by what it ports; its id only holds a slug of that.
    specName: (mode === "clone" ? asString(log?.what) : null) ?? specNameFromRunId(id, projectPath),
    taskCount: Array.isArray(log?.tasks) ? log.tasks.length : 0,
    durationMs: startedAt && finishedAt ? Date.parse(finishedAt) - Date.parse(startedAt) : null,
    usage: await readUsage(id),
  };
}

async function readUsage(id: string): Promise<TokenUsage | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(runsDir, id, "usage.json"), "utf-8"));
    const total = (parsed as { total?: unknown } | null)?.total;
    return isTokenUsage(total) ? total : null;
  } catch {
    return null;
  }
}

async function readLog(id: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(path.join(runsDir, id, "log.json"), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The clone RunLogger writes `mode: "clone"`; the feature one writes no mode at
 * all. A clone run killed before its log was written still has `clone-` after
 * the project name in its folder name, so that is the fallback.
 */
export function runModeOfLog(log: Record<string, unknown> | null, id: string): RunMode {
  if (log?.mode === "clone") return "clone";
  if (log) return "feature";
  return /^\d{4}-\d{2}-\d{2}T[\d-]+Z-.+?-clone-/.test(id) ? "clone" : "feature";
}

/**
 * RunLogger builds the folder name as `<timestamp>-<projectName>-<specSlug>`
 * and stores neither part separately, so the spec name is recovered from the
 * id by stripping the timestamp and the project name off the front.
 */
export function specNameFromRunId(id: string, projectPath: string | null): string | null {
  const projectName = projectPath ? path.basename(projectPath) : null;
  if (!projectName) return null;
  const marker = `-${projectName}-`;
  const at = id.indexOf(marker);
  return at === -1 ? null : id.slice(at + marker.length);
}

/**
 * Deletes one run's folder — the run itself, not just its listing entry.
 * `isValidRunId` (already the gate `readRun` uses) keeps this from resolving
 * outside `runs/`, so a bad id fails closed as "not found" rather than
 * deleting something it wasn't given permission to.
 */
export async function deleteRun(id: string): Promise<void> {
  if (!isValidRunId(id)) throw new RunNotFoundError(id);
  const dir = path.join(runsDir, id);
  try {
    if (!(await stat(dir)).isDirectory()) throw new RunNotFoundError(id);
  } catch {
    throw new RunNotFoundError(id);
  }
  await rm(dir, { recursive: true, force: true });
}

/**
 * Clears every run folder under `runs/`. Best-effort per entry: one folder
 * a concurrent process is touching (or a permissions hiccup) must not stop
 * the rest from being cleared, so a failed entry is skipped rather than
 * aborting the whole clear.
 */
export async function clearRuns(): Promise<number> {
  let entries: string[];
  try {
    entries = (await readdir(runsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return 0; // No runs/ folder yet — nothing to clear.
  }

  let cleared = 0;
  for (const id of entries) {
    if (!isValidRunId(id)) continue;
    try {
      await rm(path.join(runsDir, id), { recursive: true, force: true });
      cleared++;
    } catch {
      // Skip and keep going — see doc comment above.
    }
  }
  return cleared;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
