import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DIALECT_NAME, type SqlDialect, type SqlRunner } from "./database.js";
import { findDestructiveStatement } from "./sql-safety.js";
import { StageError } from "./stage-error.js";

/**
 * Runs the `.sql` files a feature run writes into the SQL folder against the
 * user's database, so the tables exist for the next coding task and for E2E
 * without anyone copying scripts into a SQL client by hand.
 *
 * Which files are "the run's own" is decided by content hash, not by trusting
 * a model's summary: everything already in the folder when the plan was made
 * is the baseline and never runs; a new file runs once and is recorded. Both
 * maps live in the feature checkpoint, so a resumed run does not create the
 * same table twice.
 */

/** Relative script path (forward slashes) → sha256 of its content. */
export type ScriptHashes = Record<string, string>;

export interface SqlScriptState {
  /** Scripts present before this run wrote anything. Never run by the pipeline. */
  baseline: ScriptHashes;
  /** Scripts this run applied, as they were when applied. */
  applied: ScriptHashes;
}

/** What the stages are told about the database. No credentials: see `describeDatabase`. */
export interface DatabaseContext {
  dialect: SqlDialect;
  /** e.g. "PostgreSQL at 10.0.0.5:5432/appdb". */
  description: string;
  /** The SQL folder scripts are written to and applied from. */
  scriptsDir: string;
}

const SKIPPED_DIRS = new Set(["node_modules", ".git", "target", "dist", "build"]);

export async function snapshotScripts(dir: string): Promise<ScriptHashes> {
  const hashes: ScriptHashes = {};
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) await walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".sql")) {
        hashes[path.relative(dir, full).split(path.sep).join("/")] = sha256(await readFile(full));
      }
    }
  };
  await walk(dir);
  return hashes;
}

/** A rollback script undoes the feature; it is written for a person, never run by the pipeline. */
export function isRollbackScript(relativePath: string): boolean {
  return /rollback/i.test(path.posix.basename(relativePath));
}

/** File-name order with numbers compared as numbers, so `2-…` runs before `10-…`. */
export function scriptOrder(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
}

export interface ApplyScriptsOptions {
  dir: string;
  state: SqlScriptState;
  runner: SqlRunner;
  onProgress: (message: string) => void;
  /** Persists `state` — called after every applied script, not once at the end. */
  save: () => Promise<void>;
}

/**
 * Applies every new script in the folder, in file-name order, each in its own
 * transaction. Stops with a StageError — nothing after it runs — when a
 * script that already ran (or was there before the run) has been edited, when
 * a new script contains a destructive statement, or when the database rejects
 * one. Returns the scripts it applied.
 */
export async function applyNewScripts({ dir, state, runner, onProgress, save }: ApplyScriptsOptions): Promise<string[]> {
  const current = await snapshotScripts(dir);
  const pending: string[] = [];

  for (const file of Object.keys(current).sort(scriptOrder)) {
    if (isRollbackScript(file)) continue;
    const known = state.applied[file] ?? state.baseline[file];
    if (known === current[file]) continue;
    if (known !== undefined) {
      throw new StageError(
        `Database: ${file} changed after ${file in state.applied ? "it was applied" : "this run started"}, so it was not run again. A script that already ran must not be edited — put the change in a new, later-numbered script, then run again.`,
      );
    }
    pending.push(file);
  }

  // Every new script is checked before any of them runs, so a refused one does
  // not leave the database with half of a feature's tables.
  const scripts = await Promise.all(
    pending.map(async (file) => ({ file, sql: await readFile(path.join(dir, file), "utf-8") })),
  );
  for (const { file, sql } of scripts) {
    const statement = findDestructiveStatement(sql);
    if (statement) {
      throw new StageError(
        `Database: ${file} was not run — it contains a destructive statement (${statement}). Feature runs only create; remove the DROP/TRUNCATE/DELETE (or move it into a script whose name contains "rollback", which is never run) and run again.`,
      );
    }
  }

  for (const { file, sql } of scripts) {
    onProgress(`Database: applying ${file}`);
    try {
      await runner.runScript(sql);
    } catch (error) {
      console.error(`Applying ${file} failed:`, error);
      throw new StageError(
        `Database: ${file} failed and was rolled back: ${error instanceof Error ? error.message : String(error)}. Fix the script and run again — the scripts before it stay applied.`,
      );
    }
    state.applied[file] = current[file];
    await save();
  }
  if (scripts.length) onProgress(`Database: applied ${scripts.length} script(s)`);
  return scripts.map((script) => script.file);
}

/**
 * Prompt block for the stages that design, plan or write the scripts, and for
 * E2E, which relies on the tables being there. Empty without a database.
 */
export function databasePromptSection(
  database: DatabaseContext | null | undefined,
  use: "design" | "code" | "e2e",
): string[] {
  if (!database) return [];
  const engine = DIALECT_NAME[database.dialect];
  if (use === "e2e") {
    return [
      "",
      "--- Database ---",
      `The pipeline created this feature's tables in ${database.description} by running the scripts in ${database.scriptsDir}.`,
      "Test against the app as it is configured; do not create or alter tables yourself.",
    ];
  }
  return [
    "",
    "--- Database (scripts are run for you) ---",
    `Engine: ${engine}, detected from the connection the user gave — ${database.description}. Assume it holds no tables for this feature yet.`,
    `Write every schema change this feature needs (CREATE TABLE, constraints, indexes, the seed rows it depends on) as .sql files in ${engine} syntax in the SQL folder: ${database.scriptsDir}.`,
    "Follow the naming already used there (for example a numeric prefix: 01-…, 02-…). After each coding task the pipeline runs every new script there against the database, in file-name order, each in its own transaction — do not run them yourself and do not leave it to the user.",
    "- Never edit a script that already exists: put a change in a new, later-numbered script. An edited script stops the run.",
    "- No DROP, TRUNCATE or DELETE in these scripts; a script containing one is refused and stops the run. A rollback script is fine if its file name contains \"rollback\" — it is never run.",
    `- Prefer re-runnable DDL where ${engine} has it (e.g. CREATE TABLE IF NOT EXISTS).`,
    ...(use === "design"
      ? ["- Name the scripts the design needs, and keep the server code's table and column names identical to them."]
      : []),
  ];
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
