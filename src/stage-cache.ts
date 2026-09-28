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
 */

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Overridable so tests do not write into the real runs/. */
const cacheDir = () => process.env.AIDEV_STAGE_CACHE_DIR ?? path.join(TOOL_ROOT, "runs", ".stage-cache");

interface CacheRecord<T> {
  savedAt: string;
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

export async function readStageCache<T>(kind: string, key: unknown[]): Promise<CacheRecord<T> | null> {
  try {
    return JSON.parse(await readFile(fileFor(kind, key), "utf-8")) as CacheRecord<T>;
  } catch {
    return null;
  }
}

export async function writeStageCache<T>(kind: string, key: unknown[], value: T): Promise<void> {
  try {
    await mkdir(cacheDir(), { recursive: true });
    await writeFile(fileFor(kind, key), JSON.stringify({ savedAt: new Date().toISOString(), value }), "utf-8");
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
  key: unknown[] | null;
  fresh?: boolean;
  run: () => Promise<T | null>;
  onHit?: (savedAt: string) => void;
}): Promise<T | null> {
  const { kind, key, fresh = false, run, onHit } = opts;
  if (key && !fresh) {
    const hit = await readStageCache<T>(kind, key);
    if (hit) {
      onHit?.(hit.savedAt);
      return hit.value;
    }
  }
  const value = await run();
  if (key && value !== null) await writeStageCache(kind, key, value);
  return value;
}

function fileFor(kind: string, key: unknown[]): string {
  const digest = createHash("sha1").update(JSON.stringify(key)).digest("hex").slice(0, 24);
  return path.join(cacheDir(), `${kind}-${digest}.json`);
}
