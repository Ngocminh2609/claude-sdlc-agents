import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { indexFor, type IndexRef } from "./project-index.js";

/**
 * Remembers an agent stage's answer for exactly the inputs it was given, so a
 * repeat of the same question costs nothing.
 *
 * The key is the question plus the content version of every repo the answer
 * was read from (git HEAD + the state of uncommitted files, from the project
 * index). If any of those repos changed, the key changes and the stage runs
 * again — a cached answer is only ever served for code that is byte-for-byte
 * where it was. A folder with no index has no version, so nothing read from it
 * is cached.
 *
 * One file per stage kind per project: a new answer overwrites the previous
 * one, so an old answer for code that has since changed is deleted, not kept
 * next to it. The file records the key it was saved under; any other key is a
 * miss.
 */

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Overridable so tests do not write into the real runs/. */
const cacheDir = () => process.env.AIDEV_STAGE_CACHE_DIR ?? path.join(TOOL_ROOT, "runs", ".stage-cache");

interface CacheRecord<T> {
  savedAt: string;
  /** Hash of the key the value was saved under. */
  key: string;
  value: T;
}

/**
 * The content versions of the repos behind these folders, or null when any
 * folder is not indexed — an answer read from it has nothing to be keyed on.
 */
export function repoVersions(indexes: IndexRef[] | undefined, folders: string[]): string[] | null {
  const versions = new Set<string>();
  for (const folder of folders) {
    const index = indexFor(indexes, folder);
    if (!index) return null;
    versions.add(`${index.repoRoot.toLowerCase()}@${index.contentVersion}`);
  }
  return [...versions].sort();
}

export async function readStageCache<T>(kind: string, project: string, key: unknown[]): Promise<CacheRecord<T> | null> {
  try {
    const record = JSON.parse(await readFile(fileFor(kind, project), "utf-8")) as CacheRecord<T>;
    return record.key === digest(key) ? record : null;
  } catch {
    return null;
  }
}

export async function writeStageCache<T>(kind: string, project: string, key: unknown[], value: T): Promise<void> {
  try {
    await mkdir(cacheDir(), { recursive: true });
    const record: CacheRecord<T> = { savedAt: new Date().toISOString(), key: digest(key), value };
    await writeFile(fileFor(kind, project), JSON.stringify(record), "utf-8");
  } catch {
    // A cache that cannot be written only costs the next run a stage call.
  }
}

/**
 * Runs a stage through the cache: a hit returns the saved answer without the
 * stage (unless `fresh`), a miss runs it and saves a non-null answer. A null
 * key means the inputs cannot be versioned — the stage always runs.
 */
export async function cachedStage<T>(opts: {
  kind: string;
  /** The project the answer is about: its one cache file per kind. */
  project: string;
  key: unknown[] | null;
  fresh?: boolean;
  run: () => Promise<T | null>;
  onHit?: (savedAt: string) => void;
}): Promise<T | null> {
  const { kind, project, key, fresh = false, run, onHit } = opts;
  if (key && !fresh) {
    const hit = await readStageCache<T>(kind, project, key);
    if (hit) {
      onHit?.(hit.savedAt);
      return hit.value;
    }
  }
  const value = await run();
  if (key && value !== null) await writeStageCache(kind, project, key, value);
  return value;
}

function fileFor(kind: string, project: string): string {
  const resolved = path.resolve(project);
  const id = createHash("sha1").update(process.platform === "win32" ? resolved.toLowerCase() : resolved).digest("hex").slice(0, 16);
  return path.join(cacheDir(), `${kind}-${slug(path.basename(resolved))}-${id}.json`);
}

function digest(key: unknown[]): string {
  return createHash("sha1").update(JSON.stringify(key)).digest("hex");
}

function slug(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 40) || "project";
}
