import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { clientCallsInSource, routesInSource } from "./clone-wiring.js";

/**
 * A per-repository index of every file, kept on disk and refreshed from git,
 * so agents look things up instead of walking the tree.
 *
 * Why: most of what a run spends goes on agents finding their way around —
 * Glob and Grep over thousands of files, reading directory after directory —
 * and each stage session does it again from nothing. The answer to "where is
 * the controller for X, which file holds the menu label Y" does not change
 * between runs unless the code does, so it is computed once, by plain code,
 * and only the files git says changed are read again.
 *
 * What an entry holds is what those searches look for: the path, a kind
 * (controller, service, entity, page, api-client, sql, locale…) and short tags
 * — class and package, @Table names, mapped routes, API URLs a client calls,
 * route paths, exported names, CREATE TABLE names, Vietnamese UI strings. The
 * index is written as one line per file (`index.txt`), so an agent can Grep it
 * in one call and open only the files it needs.
 *
 * Freshness: keyed to git. A refresh diffs the cached HEAD against the current
 * one, adds the uncommitted and untracked files, and re-reads those whose size
 * or mtime moved. A folder that is not in a git repo is indexed by a plain walk
 * and re-stat'ed every time. The index is a map, not the territory: stages are
 * told to open a file before relying on it.
 */

const execFileAsync = promisify(execFile);
const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Where indexes live; overridable so tests do not write into the real runs/. */
const indexRoot = () => process.env.AIDEV_INDEX_DIR ?? path.join(TOOL_ROOT, "runs", ".project-index");
/** Bumped when what an entry holds changes, so old indexes are rebuilt. */
const INDEX_VERSION = 2;

const MAX_EXTRACT_BYTES = 512 * 1024;
const TEXT_EXTENSIONS = new Set([
  ".java", ".kt", ".scala", ".groovy", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue",
  ".sql", ".xml", ".yml", ".yaml", ".properties", ".json", ".less", ".css", ".scss", ".html",
  ".md", ".py", ".go", ".cs", ".gradle", ".sh", ".ps1", ".cmd", ".bat", ".env.example",
]);
const SKIP_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp", ".bmp", ".woff", ".woff2", ".ttf", ".eot",
  ".jar", ".war", ".class", ".zip", ".gz", ".7z", ".rar", ".pdf", ".doc", ".docx", ".xls", ".xlsx",
  ".ppt", ".pptx", ".mp4", ".mp3", ".exe", ".dll", ".so", ".dylib", ".lock", ".map",
]);
const WALK_SKIP = new Set(["node_modules", ".git", "target", "build", "dist", "out", ".idea", ".umi", ".umi-production", "coverage", "log_app", "log_app_debug"]);
// CI/CD config (.gitlab-ci.yml, GitHub Actions workflows, Jenkinsfile, azure/bitbucket
// pipelines) and Dockerfile count as manifests too: they define what the pipeline
// actually builds/lints/tests, and a project's structure hash must change when they do
// (see target-conventions-cache.ts's reliance on this hash to know the target changed).
// Case-insensitive because Dockerfile/Jenkinsfile are tested against both the original
// filename (computeStructureHash) and the lowercased one (kindOf).
const MANIFEST_NAMES =
  /(^|\/)(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|package\.json|pnpm-workspace\.yaml|tsconfig[^/]*\.json|\.umirc\.ts|application[^/]*\.ya?ml|application[^/]*\.properties|\.gitlab-ci\.ya?ml|jenkinsfile|azure-pipelines\.ya?ml|bitbucket-pipelines\.ya?ml|dockerfile|\.github\/workflows\/[^/]+\.ya?ml)$/i;

export interface IndexEntry {
  size: number;
  mtimeMs: number;
  kind: string;
  tags: string[];
}

interface IndexFile {
  version: number;
  repoRoot: string;
  /** git HEAD at the last refresh, or null when the folder is not a git repo. */
  head: string | null;
  /** Files that were uncommitted/untracked at the last refresh. */
  dirty: string[];
  /** Changes when a module, directory or build manifest changes — not on every edit. */
  structureHash: string;
  refreshedAt: string;
  files: Record<string, IndexEntry>;
}

export interface IndexedRepo {
  repoRoot: string;
  /** The one-line-per-file text index agents Grep. */
  indexFile: string;
  indexDir: string;
  head: string | null;
  structureHash: string;
  /** head + a hash of the uncommitted files — changes whenever the code does. */
  contentVersion: string;
  fileCount: number;
  changedFiles: number;
  rebuilt: boolean;
}

/**
 * Refreshes the indexes a run needs and says what happened, one progress line
 * per repo. Never fails the run: an index that cannot be built leaves stages
 * exploring the old way, which is slower, not wrong.
 */
export async function refreshIndexesForRun(
  folders: string[],
  onProgress: (message: string) => void,
): Promise<IndexRef[]> {
  try {
    const started = Date.now();
    const repos = await refreshProjectIndexes(folders);
    for (const repo of repos) {
      const state = repo.rebuilt
        ? `built (${repo.fileCount} files)`
        : repo.changedFiles
          ? `${repo.changedFiles} changed file(s) re-indexed (${repo.fileCount} files)`
          : `up to date (${repo.fileCount} files)`;
      onProgress(`Project index: ${path.basename(repo.repoRoot)} — ${state}`);
    }
    onProgress(`Project index: ready in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return repos.map(({ repoRoot, indexFile, indexDir, structureHash, contentVersion }) => ({
      repoRoot,
      indexFile,
      indexDir,
      structureHash,
      contentVersion,
    }));
  } catch (error) {
    console.error("Project index refresh failed:", error);
    onProgress("Project index: unavailable — stages will explore the projects themselves");
    return [];
  }
}

/** Refreshes (or builds) the index of every repo in the given folders; one result per repo. */
export async function refreshProjectIndexes(folders: string[]): Promise<IndexedRepo[]> {
  const repos = new Set<string>();
  for (const folder of folders) for (const repo of await reposIn(folder)) repos.add(repo);
  const results: IndexedRepo[] = [];
  for (const repo of repos) results.push(await refreshRepo(repo));
  return results;
}

/**
 * The repos a folder stands for: the git repo it is in, or — for a parent
 * folder holding several repos, like a BE and an FE side by side — each repo
 * one or two levels down. A folder with neither is indexed on its own.
 */
async function reposIn(folder: string): Promise<string[]> {
  const resolved = path.resolve(folder);
  const top = await gitTopLevel(resolved);
  if (top) return [top];

  const found: string[] = [];
  const scan = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || WALK_SKIP.has(entry.name)) continue;
      const child = path.join(dir, entry.name);
      if (existsSync(path.join(child, ".git"))) found.push(child);
      else if (depth < 2) scan(child, depth + 1);
    }
  };
  scan(resolved, 1);
  return found.length ? found : [resolved];
}

async function refreshRepo(repoRoot: string): Promise<IndexedRepo> {
  const indexDir = path.join(indexRoot(), `${slug(path.basename(repoRoot))}-${hash(repoRoot.toLowerCase()).slice(0, 8)}`);
  const jsonPath = path.join(indexDir, "index.json");
  const textPath = path.join(indexDir, "index.txt");

  const previous = await readIndex(jsonPath, repoRoot);
  const isGit = Boolean(await gitTopLevel(repoRoot));
  const head = isGit ? await git(repoRoot, ["rev-parse", "HEAD"]).then((out) => out.trim() || null) : null;

  const listed = isGit ? await gitList(repoRoot) : walkList(repoRoot);
  const dirtyNow = isGit ? await gitDirty(repoRoot) : [];

  let files: Record<string, IndexEntry>;
  let changed = 0;
  let rebuilt = false;

  // Which paths might differ from what is indexed. Null means "we cannot tell
  // cheaply — look at every file" (first run, a folder outside git, or a HEAD
  // the cache cannot be diffed against).
  let candidates: Set<string> | null = null;
  if (previous && isGit && previous.head && head) {
    const committed =
      previous.head === head ? [] : await git(repoRoot, ["diff", "--name-only", "-z", previous.head, head]).then(splitZ, () => null);
    if (committed) candidates = new Set([...committed, ...dirtyNow, ...previous.dirty]);
  }

  if (!previous) {
    rebuilt = true;
    files = {};
    for (const file of listed) {
      const entry = await indexFile(repoRoot, file);
      if (entry) files[file] = entry;
    }
    changed = Object.keys(files).length;
  } else {
    files = { ...previous.files };
    const listedSet = new Set(listed);
    // Deleted files drop out whichever way they went.
    for (const file of Object.keys(files)) {
      if (!listedSet.has(file)) {
        delete files[file];
        changed++;
      }
    }
    const toCheck = candidates ? [...candidates].filter((file) => listedSet.has(file)) : listed;
    // New files the diff did not name (a first index outside git, a missed
    // untracked file) are caught by being listed but not indexed.
    for (const file of listed) if (!files[file] && candidates && !candidates.has(file)) toCheck.push(file);
    for (const file of toCheck) {
      const stat = statOf(path.join(repoRoot, file));
      const known = files[file];
      if (!stat) continue;
      if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs) continue;
      const entry = await indexFile(repoRoot, file);
      if (entry) files[file] = entry;
      else delete files[file];
      changed++;
    }
  }

  const structureHash = await computeStructureHash(repoRoot, Object.keys(files));
  const index: IndexFile = {
    version: INDEX_VERSION,
    repoRoot,
    head,
    dirty: dirtyNow,
    structureHash,
    refreshedAt: new Date().toISOString(),
    files,
  };

  if (changed || !previous || previous.head !== head || !existsSync(textPath)) {
    await mkdir(indexDir, { recursive: true });
    await writeFile(jsonPath, JSON.stringify(index), "utf-8");
    await writeFile(textPath, renderText(index), "utf-8");
  }

  // In git: HEAD plus the state of the uncommitted files. Outside git: every
  // file's size and mtime — there is no cheaper honest signal.
  const stamp = (list: string[]) => hash(list.map((file) => `${file}:${files[file]?.size ?? 0}:${files[file]?.mtimeMs ?? 0}`).join("|")).slice(0, 16);
  const contentVersion = isGit ? `${head}:${stamp(dirtyNow)}` : `nogit:${stamp(Object.keys(files).sort())}`;
  return {
    repoRoot,
    indexFile: textPath,
    indexDir,
    head,
    structureHash,
    contentVersion,
    fileCount: Object.keys(files).length,
    changedFiles: changed,
    rebuilt,
  };
}

// --- Per-file extraction -------------------------------------------------

async function indexFile(repoRoot: string, file: string): Promise<IndexEntry | null> {
  const ext = extensionOf(file);
  if (SKIP_EXTENSIONS.has(ext)) return null;
  const stat = statOf(path.join(repoRoot, file));
  if (!stat) return null;

  let tags: string[] = [];
  if (TEXT_EXTENSIONS.has(ext) && stat.size <= MAX_EXTRACT_BYTES) {
    try {
      tags = extractTags(file, await readFile(path.join(repoRoot, file), "utf-8"));
    } catch {
      tags = [];
    }
  }
  return { size: stat.size, mtimeMs: stat.mtimeMs, kind: kindOf(file, tags), tags };
}

/** The short facts a search for this file would look for. Exported for tests. */
export function extractTags(file: string, source: string): string[] {
  const ext = extensionOf(file);
  const tags: string[] = [];
  const add = (tag: string | undefined) => {
    if (tag && !tags.includes(tag)) tags.push(tag);
  };

  if (ext === ".java" || ext === ".kt" || ext === ".scala" || ext === ".groovy") {
    add(source.match(/^\s*package\s+([\w.]+)/m)?.[1]);
    add(source.match(/\b(?:class|interface|enum|record|object)\s+(\w+)/)?.[1]);
    for (const annotation of ["RestController", "Controller", "Service", "Repository", "Entity", "Mapper", "Configuration", "Component", "FeignClient", "MappedSuperclass"]) {
      if (new RegExp(`@${annotation}\\b`).test(source)) add(`@${annotation}`);
    }
    add(source.match(/@Table\s*\(\s*name\s*=\s*"([^"]+)"/)?.[1]?.replace(/^/, "table:"));
    add(source.match(/@Tag\s*\(\s*name\s*=\s*"([^"]+)"/)?.[1]?.replace(/^/, "tag:"));
    const extendsMatch = source.match(/\b(?:extends|implements)\s+([\w<>, .]+?)\s*\{/)?.[1];
    if (extendsMatch) add(`extends:${extendsMatch.replace(/\s+/g, "").slice(0, 80)}`);
    for (const route of routesInSource(source, file).slice(0, 16)) add(route);
  } else if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue"].includes(ext)) {
    for (const match of source.matchAll(/\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|const|class|let|interface|type|enum)\s+(\w+)/g)) {
      if (tags.length < 20) add(match[1]);
    }
    for (const match of source.matchAll(/\bpath\s*:\s*['"`]([^'"`]+)['"`]/g)) add(`route:${match[1]}`);
    for (const call of clientCallsInSource(source).slice(0, 16)) add(`calls:${call}`);
    for (const route of routesInSource(source, file).slice(0, 16)) add(route);
    for (const text of vietnameseStrings(source).slice(0, 12)) add(`"${text}"`);
  } else if (ext === ".sql") {
    for (const match of source.matchAll(/\bcreate\s+(?:or\s+replace\s+)?(table|view|sequence|index)\s+(?:if\s+not\s+exists\s+)?([\w."]+)/gi)) {
      add(`${match[1].toLowerCase()}:${match[2].replace(/"/g, "")}`);
    }
    for (const match of source.matchAll(/\binsert\s+into\s+([\w."]+)/gi)) add(`insert:${match[1].replace(/"/g, "")}`);
  } else if (ext === ".xml") {
    add(source.match(/<mapper\s+namespace="([^"]+)"/)?.[1]?.replace(/^/, "mapper:"));
    add(source.match(/<artifactId>([^<]+)<\/artifactId>/)?.[1]?.replace(/^/, "artifact:"));
    for (const match of source.matchAll(/<module>([^<]+)<\/module>/g)) add(`module:${match[1]}`);
  } else if (ext === ".yml" || ext === ".yaml" || ext === ".properties") {
    for (const key of ["ddl-auto", "context-path", "application.name", "port"]) {
      const value = source.match(new RegExp(`${key.replace(".", "\\.")}\\s*[:=]\\s*([^\\s#]+)`))?.[1];
      if (value) add(`${key}=${value}`);
    }
  } else if (ext === ".json" && path.basename(file) === "package.json") {
    try {
      const pkg = JSON.parse(source) as { name?: string; scripts?: Record<string, string> };
      add(pkg.name ? `name:${pkg.name}` : undefined);
      for (const script of Object.keys(pkg.scripts ?? {}).slice(0, 12)) add(`script:${script}`);
    } catch {
      // Not valid JSON — leave it path-only.
    }
  }
  return tags;
}

/** Vietnamese UI strings: menu labels, titles, messages — what a Vietnamese keyword matches. */
function vietnameseStrings(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/(['"`])([^'"`\n]{2,80})\1/g)) {
    const text = match[2].trim();
    if (/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(text)) found.add(text.slice(0, 60));
    if (found.size >= 12) break;
  }
  return [...found];
}

function kindOf(file: string, tags: string[]): string {
  const lower = file.toLowerCase();
  const has = (tag: string) => tags.includes(tag);
  if (/(^|\/)(src\/test|__tests__|tests?)\//.test(lower) || /\.(test|spec)\.[jt]sx?$/.test(lower) || /test\.(java|kt)$/.test(lower)) return "test";
  if (has("@RestController") || has("@Controller")) return "controller";
  if (has("@Service")) return "service";
  if (has("@Repository") || /repository\.(java|kt)$/.test(lower)) return "repository";
  if (has("@Entity") || has("@MappedSuperclass")) return "entity";
  if (has("@Mapper") || lower.includes("/mapper")) return "mapper";
  if (has("@Configuration")) return "config";
  if (/(dto|request|response|model|vo)s?\//.test(lower) || /(dto|request|response)\.(java|kt|ts)$/.test(lower)) return "dto";
  if (lower.endsWith(".sql")) return "sql";
  if (MANIFEST_NAMES.test(lower)) return "build/config";
  if (/(^|\/)(locales?|i18n|lang)\//.test(lower)) return "locale";
  if (/\.[jt]sx?$/.test(lower) && (/(^|\/)(services?|apis?)\//.test(lower) || /(service|api)s?\.[jt]sx?$/.test(lower) || tags.some((tag) => tag.startsWith("calls:")))) {
    return "api-client";
  }
  if (/(^|\/)routes?\.[jt]sx?$/.test(lower) || lower.includes("/router")) return "routes";
  if (/(^|\/)pages?\//.test(lower) && /\.(tsx|jsx|vue)$/.test(lower)) return "page";
  if (/(^|\/)components?\//.test(lower)) return "component";
  if (/\.(java|kt)$/.test(lower)) return "java";
  if (/\.(tsx?|jsx?)$/.test(lower)) return "script";
  return extensionOf(file).slice(1) || "file";
}

// --- The text form agents read -------------------------------------------

function renderText(index: IndexFile): string {
  const paths = Object.keys(index.files).sort();
  const dirs = new Map<string, number>();
  for (const file of paths) {
    const parts = file.split("/");
    for (let depth = 1; depth < parts.length && depth <= 5; depth++) {
      const dir = parts.slice(0, depth).join("/");
      dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
    }
  }
  const kinds = new Map<string, number>();
  for (const entry of Object.values(index.files)) kinds.set(entry.kind, (kinds.get(entry.kind) ?? 0) + 1);

  const lines = [
    `# Project index — ${index.repoRoot}`,
    `# git HEAD ${index.head ?? "(not a git repo)"} · refreshed ${index.refreshedAt} · ${paths.length} files`,
    `# Kinds: ${[...kinds.entries()].sort((a, b) => b[1] - a[1]).map(([kind, count]) => `${kind} ${count}`).join(", ")}`,
    "# Format: <path relative to the repo root> | <kind> | <tags: package/class, @annotations, table:, tag:, routes, calls:, route:, \"UI strings\">",
    "#",
    "# Directories (depth ≤ 5, file counts):",
    ...[...dirs.entries()].slice(0, 400).map(([dir, count]) => `#   ${dir}/ (${count})`),
    "",
    ...paths.map((file) => {
      const entry = index.files[file];
      return `${file} | ${entry.kind}${entry.tags.length ? ` | ${entry.tags.join("; ")}` : ""}`;
    }),
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * Prompt block pointing a stage at the indexes: where they are and how to use
 * them so the stage searches one file instead of the tree.
 */
export function indexPromptSection(repos: IndexRef[] | undefined): string[] {
  if (!repos?.length) return [];
  return [
    "",
    "--- Project index (read this BEFORE exploring any folder) ---",
    "Every file of these repositories is listed, one line each, with its kind and key facts",
    "(class/package, @annotations, table names, mapped routes, API URLs called, route paths,",
    "exported names, Vietnamese UI strings). It is current as of this run (refreshed from git).",
    ...repos.map((repo) => `- ${repo.repoRoot}  →  index: ${repo.indexFile}`),
    "Use Grep on the index file(s) to find files — by class name, table, route, keyword or",
    "Vietnamese label — then Read only the files you need. An index file can be large: Grep it,",
    "never Read it whole. Do not Glob or Grep across a whole repository when the index answers",
    "the question; that is what this run is trying not to pay for.",
    "The index says where things are, not what they contain: open a file before relying on it.",
  ];
}

/** What a stage and a cache need to know about one indexed repo. */
export type IndexRef = Pick<IndexedRepo, "repoRoot" | "indexFile" | "indexDir" | "structureHash" | "contentVersion">;

/** The index covering a folder: the repo it is in, if that repo was indexed. */
export function indexFor(repos: IndexRef[] | undefined, folder: string): IndexRef | undefined {
  const target = path.resolve(folder).toLowerCase();
  return (repos ?? []).find((repo) => {
    const root = path.resolve(repo.repoRoot).toLowerCase();
    return target === root || target.startsWith(`${root}${path.sep}`);
  });
}

/** Index folders a stage needs read access to. */
export function indexDirectories(repos: IndexRef[] | undefined): string[] {
  return [...new Set((repos ?? []).map((repo) => repo.indexDir))];
}

/** Gives a stage read access to the index folders (they live outside every project). */
export function withIndexAccess(options: Options, repos: IndexRef[] | undefined): Options {
  const dirs = indexDirectories(repos);
  if (dirs.length) options.additionalDirectories = [...new Set([...(options.additionalDirectories ?? []), ...dirs])];
  return options;
}

/**
 * Index lines matching any of the terms (case- and diacritic-insensitive),
 * for putting the likeliest candidates straight into a prompt.
 */
export async function searchIndexes(repos: IndexRef[], terms: string[], limit = 80): Promise<string[]> {
  const needles = [...new Set(terms.map(fold).filter((term) => term.length >= 3))];
  if (!needles.length) return [];
  const hits: string[] = [];
  for (const repo of repos) {
    let text: string;
    try {
      text = await readFile(repo.indexFile, "utf-8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const folded = fold(line);
      if (needles.some((needle) => folded.includes(needle))) {
        hits.push(`${path.basename(repo.repoRoot)}/${line}`);
        if (hits.length >= limit) return hits;
      }
    }
  }
  return hits;
}

function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase();
}

// --- git and filesystem helpers ------------------------------------------

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

async function gitTopLevel(folder: string): Promise<string | null> {
  try {
    const top = (await git(folder, ["rev-parse", "--show-toplevel"])).trim();
    return top ? path.resolve(top) : null;
  } catch {
    return null;
  }
}

async function gitList(repoRoot: string): Promise<string[]> {
  return splitZ(await git(repoRoot, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]))
    .filter((file) => !SKIP_EXTENSIONS.has(extensionOf(file)))
    .filter((file) => existsSync(path.join(repoRoot, file)));
}

/** Tracked files modified since HEAD (staged or not) plus untracked, not-ignored files. */
async function gitDirty(repoRoot: string): Promise<string[]> {
  const modified = await git(repoRoot, ["diff", "--name-only", "-z", "HEAD"]).then(splitZ, () => []);
  const untracked = await git(repoRoot, ["ls-files", "-z", "--others", "--exclude-standard"]).then(splitZ, () => []);
  return [...new Set([...modified, ...untracked])].sort();
}

function walkList(root: string): string[] {
  const files: string[] = [];
  const stack = [root];
  while (stack.length && files.length < 50000) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!WALK_SKIP.has(entry.name) && !entry.name.startsWith(".")) stack.push(path.join(dir, entry.name));
      } else if (entry.isFile() && !SKIP_EXTENSIONS.has(extensionOf(entry.name))) {
        files.push(path.relative(root, path.join(dir, entry.name)).split(path.sep).join("/"));
      }
    }
  }
  return files.sort();
}

async function computeStructureHash(repoRoot: string, files: string[]): Promise<string> {
  const dirs = new Set<string>();
  const manifests: string[] = [];
  for (const file of files) {
    const parts = file.split("/");
    for (let depth = 1; depth < parts.length && depth <= 4; depth++) dirs.add(parts.slice(0, depth).join("/"));
    if (MANIFEST_NAMES.test(file)) manifests.push(file);
  }
  const manifestHashes: string[] = [];
  for (const manifest of manifests.sort()) {
    try {
      manifestHashes.push(`${manifest}:${hash(await readFile(path.join(repoRoot, manifest), "utf-8"))}`);
    } catch {
      manifestHashes.push(`${manifest}:?`);
    }
  }
  return hash([...[...dirs].sort(), ...manifestHashes].join("\n"));
}

async function readIndex(jsonPath: string, repoRoot: string): Promise<IndexFile | null> {
  try {
    const parsed = JSON.parse(await readFile(jsonPath, "utf-8")) as IndexFile;
    if (parsed.version !== INDEX_VERSION || path.resolve(parsed.repoRoot) !== path.resolve(repoRoot)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function statOf(file: string): { size: number; mtimeMs: number } | null {
  try {
    const stat = statSync(file);
    return stat.isFile() ? { size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) } : null;
  } catch {
    return null;
  }
}

function splitZ(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

function extensionOf(file: string): string {
  return path.extname(file).toLowerCase();
}

function hash(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

function slug(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 40) || "repo";
}
