import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { TargetConventions } from "./types.js";

/**
 * Caches `readTargetConventions`'s result per target project, so cloning
 * several features into the same project in separate `aidev clone` runs
 * doesn't pay for an identical agent call each time — the answer ("how is
 * this project organised") does not depend on which feature is being ported.
 *
 * Keyed to the target project's git HEAD rather than a directory mtime: a
 * commit hash is a cheap, unambiguous signal that the project might have
 * changed, and mtimes are unreliable across editors/OSes/checkouts. A
 * project that isn't a git repo (or where `git` isn't available) always
 * misses — there's no cheap, reliable signal to key on, so "always
 * recompute" is the honest fallback rather than caching forever or guessing
 * from mtimes.
 *
 * Known limitation, stated rather than silently accepted: an uncommitted
 * structural change (a new module added but not yet committed) will not
 * invalidate the cache, since HEAD hasn't moved. Hashing the working tree
 * would close that gap but is expensive on a large repo and defeats the
 * point of caching — this is a disclosed trade-off, not an oversight.
 */

const execFileAsync = promisify(execFile);
const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_PATH = path.join(TOOL_ROOT, "runs", ".target-conventions-cache.json");

interface CacheEntry {
  gitHead: string;
  conventions: TargetConventions;
}

type CacheFile = Record<string, CacheEntry>;

async function gitHead(projectPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: projectPath });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function readCacheFile(): Promise<CacheFile> {
  try {
    return JSON.parse(await readFile(CACHE_PATH, "utf-8")) as CacheFile;
  } catch {
    return {};
  }
}

async function writeCacheFile(cache: CacheFile): Promise<void> {
  await mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2), "utf-8");
}

/** A cache hit for this exact project at its current commit, or null on a miss. */
export async function getCachedTargetConventions(projectPath: string): Promise<TargetConventions | null> {
  const head = await gitHead(projectPath);
  if (!head) return null;

  const cache = await readCacheFile();
  const entry = cache[path.resolve(projectPath)];
  if (!entry || entry.gitHead !== head) return null;
  return entry.conventions;
}

/** No-op (does not throw) when the project isn't a git repo — nothing stable to key on. */
export async function storeTargetConventions(
  projectPath: string,
  conventions: TargetConventions,
): Promise<void> {
  const head = await gitHead(projectPath);
  if (!head) return;

  const cache = await readCacheFile();
  cache[path.resolve(projectPath)] = { gitHead: head, conventions };
  await writeCacheFile(cache);
}
