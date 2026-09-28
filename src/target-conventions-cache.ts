import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { indexFor, type IndexRef } from "./project-index.js";
import type { ProjectRoot } from "./target-roots.js";
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

/**
 * Bumped whenever the Target Conventions prompt starts asking for something
 * new: an answer cached under an older prompt lacks it (version 2 added how
 * tables get created), and an unchanged git HEAD would otherwise keep serving
 * that incomplete answer forever.
 */
const CONVENTIONS_VERSION = 2;

interface CacheEntry {
  gitHead: string;
  conventions: TargetConventions;
  version?: number;
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

type Target = string | ProjectRoot[];

/**
 * The cache key and version for a target. A split BE/FE project is keyed by
 * both folders and versioned by both HEADs — a commit on either side changes
 * the conventions — and is uncachable if either folder is not a git repo.
 */
async function keyAndHead(target: Target, indexes?: IndexRef[]): Promise<{ key: string; head: string } | null> {
  if (typeof target === "string") {
    const head = await versionOf(target, indexes);
    return head ? { key: path.resolve(target), head } : null;
  }
  if (target.length === 1) return keyAndHead(target[0].path, indexes);

  const heads: string[] = [];
  for (const root of target) {
    const head = await versionOf(root.path, indexes);
    if (!head) return null;
    heads.push(head);
  }
  return {
    key: target.map((root) => `${root.role}:${path.resolve(root.path)}`).join("|"),
    head: heads.join("|"),
  };
}

/**
 * What the cached answer is versioned by. With a project index: the repo's
 * structure hash — its directories and build manifests — so an ordinary commit
 * that edits code inside existing modules keeps the answer, and a new module,
 * a moved folder or a changed pom.xml/package.json/application.yml drops it.
 * The conventions describe layout, which is exactly what that hash covers.
 * Without an index: the git HEAD, as before.
 */
async function versionOf(folder: string, indexes?: IndexRef[]): Promise<string | null> {
  const index = indexFor(indexes, folder);
  if (index) return `structure:${index.structureHash}`;
  return gitHead(folder);
}

/** A cache hit for this exact project at its current structure (or commit), or null on a miss. */
export async function getCachedTargetConventions(
  target: Target,
  indexes?: IndexRef[],
): Promise<TargetConventions | null> {
  const version = await keyAndHead(target, indexes);
  if (!version) return null;

  const cache = await readCacheFile();
  const entry = cache[version.key];
  if (!entry || entry.gitHead !== version.head || entry.version !== CONVENTIONS_VERSION) return null;
  return entry.conventions;
}

/** No-op (does not throw) when a folder isn't a git repo — nothing stable to key on. */
export async function storeTargetConventions(
  target: Target,
  conventions: TargetConventions,
  indexes?: IndexRef[],
): Promise<void> {
  const version = await keyAndHead(target, indexes);
  if (!version) return;

  const cache = await readCacheFile();
  cache[version.key] = { gitHead: version.head, conventions, version: CONVENTIONS_VERSION };
  await writeCacheFile(cache);
}
