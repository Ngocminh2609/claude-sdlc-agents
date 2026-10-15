import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { indexFor, type IndexRef } from "./project-index.js";
import type { VerifyCommand } from "./verify-gate.js";
import type { ProjectRoot } from "./target-roots.js";

/**
 * A per-project map that outlives runs: how the project is organised, and
 * which features earlier runs built into it, task by task. It works whether or
 * not the project is in git.
 *
 * Why: every feature run used to start with an agent scanning the whole target
 * project for its conventions (an 11-turn session on a real run), and the
 * answer was thrown away as soon as any file changed — which is every run,
 * because a run writes code. Conventions only change when the build does, so
 * they are kept here keyed on the build manifests' hash (\`manifestHash\` from
 * the project index), and the next run reuses them without a scan. The feature
 * list tells the design stage where the project stands without re-reading it.
 *
 * Lives in this repo's \`runs/.project-memory/\`, never in the target project:
 * one JSON file per set of target folders, plus a rendered \`.md\` next to it
 * for a person (or an agent) to skim.
 */

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Overridable so tests never write into the real runs/ — which holds every checkpoint and the history. */
const memoryDir = () => process.env.AIDEV_MEMORY_DIR ?? path.join(TOOL_ROOT, "runs", ".project-memory");
const MEMORY_VERSION = 1;
/** Enough to carry names and decisions forward; the full report is in the run log. */
const MAX_TASK_SUMMARY = 600;
/** How many earlier features a prompt lists, newest first. */
const MAX_FEATURES_IN_PROMPT = 12;

export interface FeatureTask {
  id: string;
  summary: string;
  files?: string[];
}

export interface FeatureRecord {
  /** The spec's first heading. */
  title: string;
  /** Hash of the spec text: running the same spec again updates its record. */
  specKey: string;
  startedAt: string;
  updatedAt: string;
  /** "in-progress" while tasks are being written, then the run's final status. */
  status: string;
  tasks: FeatureTask[];
}

export interface ProjectMemory {
  version: number;
  /** `role:path` of every target folder this map describes. */
  roots: string[];
  conventions?: { text: string; manifestKey: string; savedAt: string; verifyCommands?: VerifyCommand[] };
  features: FeatureRecord[];
}

export interface SpecIdentity {
  title: string;
  specKey: string;
}

export function specIdentity(specMarkdown: string): SpecIdentity {
  const heading = specMarkdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return { title: heading || "(untitled spec)", specKey: sha(specMarkdown.trim()).slice(0, 16) };
}

/**
 * The build-manifest version of every target folder, or null when one is not
 * indexed — conventions read from a folder with no version cannot be reused.
 */
export function manifestKeyOf(indexes: IndexRef[] | undefined, roots: ProjectRoot[]): string | null {
  const keys: string[] = [];
  for (const root of roots) {
    const manifestHash = indexFor(indexes, root.path)?.manifestHash;
    if (!manifestHash) return null;
    keys.push(`${root.role}:${manifestHash}`);
  }
  return keys.length ? keys.sort().join("|") : null;
}

/**
 * Saved conventions and build-check commands, when the build manifests are the
 * ones they were read under. Conventions saved before the build check existed
 * have no commands and are not reused: one scan fills them in.
 */
export function reusableConventions(
  memory: ProjectMemory | null | undefined,
  manifestKey: string | null,
): { text: string; verifyCommands: VerifyCommand[] } | null {
  const saved = memory?.conventions;
  if (!saved || !manifestKey || saved.manifestKey !== manifestKey || !Array.isArray(saved.verifyCommands)) return null;
  return { text: saved.text, verifyCommands: saved.verifyCommands };
}

export async function loadProjectMemory(roots: ProjectRoot[]): Promise<ProjectMemory> {
  try {
    const parsed = JSON.parse(await readFile(memoryPath(roots), "utf-8")) as ProjectMemory;
    if (parsed.version === MEMORY_VERSION && Array.isArray(parsed.features)) return parsed;
  } catch {
    // Missing or unreadable: start an empty map rather than failing the run.
  }
  return { version: MEMORY_VERSION, roots: rootKeys(roots), features: [] };
}

export async function rememberConventions(
  roots: ProjectRoot[],
  manifestKey: string,
  text: string,
  // Left out when the scan had none to give (a scan cached before the build
  // check existed), so the next run scans again rather than reusing "no commands".
  verifyCommands?: VerifyCommand[],
): Promise<void> {
  await update(roots, (memory) => {
    memory.conventions = {
      text,
      manifestKey,
      savedAt: new Date().toISOString(),
      ...(verifyCommands ? { verifyCommands } : {}),
    };
  });
}

/** Records a finished task under its feature, creating the feature on its first task. */
export async function rememberTask(roots: ProjectRoot[], spec: SpecIdentity, task: FeatureTask): Promise<void> {
  await update(roots, (memory) => {
    const feature = featureFor(memory, spec);
    const entry = { ...task, summary: shorten(task.summary, MAX_TASK_SUMMARY) };
    const at = feature.tasks.findIndex((done) => done.id === task.id);
    if (at === -1) feature.tasks.push(entry);
    else feature.tasks[at] = entry;
  });
}

/** Sets a feature's final status; a run that wrote no task leaves the map untouched. */
export async function rememberFeatureStatus(roots: ProjectRoot[], spec: SpecIdentity, status: string): Promise<void> {
  const memory = await loadProjectMemory(roots);
  const feature = memory.features.find((candidate) => candidate.specKey === spec.specKey);
  if (!feature) return;
  feature.status = status;
  feature.updatedAt = new Date().toISOString();
  await save(roots, memory);
}

/** What earlier runs built into this project, for the stages that plan new work. */
export function projectMemoryPromptSection(memory: ProjectMemory | null | undefined): string[] {
  const features = (memory?.features ?? []).filter((feature) => feature.tasks.length);
  if (!features.length) return [];
  const recent = [...features].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_FEATURES_IN_PROMPT);
  const lines = [
    "",
    "--- Project map: features earlier runs built into this project (newest first) ---",
    "Use it to know what already exists and where; open a file before relying on it.",
  ];
  for (const feature of recent) {
    lines.push(`- ${feature.title} (${feature.updatedAt.slice(0, 10)}, ${feature.status})`);
    for (const task of feature.tasks) {
      const files = task.files?.length ? ` [${task.files.join(", ")}]` : "";
      lines.push(`  - ${task.id}: ${firstSentence(task.summary)}${files}`);
    }
  }
  return lines;
}

// --- storage ---------------------------------------------------------------

async function update(roots: ProjectRoot[], change: (memory: ProjectMemory) => void): Promise<void> {
  const memory = await loadProjectMemory(roots);
  change(memory);
  await save(roots, memory);
}

async function save(roots: ProjectRoot[], memory: ProjectMemory): Promise<void> {
  // A unit test must never write the real map: it sits next to every checkpoint in runs/.
  if (process.env.VITEST && !process.env.AIDEV_MEMORY_DIR) {
    throw new Error("project-memory: set AIDEV_MEMORY_DIR in the test before writing a project map.");
  }
  const target = memoryPath(roots);
  await mkdir(path.dirname(target), { recursive: true });
  await writeAtomically(target, JSON.stringify(memory, null, 2));
  await writeAtomically(target.replace(/\.json$/, ".md"), renderMarkdown(memory));
}

async function writeAtomically(target: string, content: string): Promise<void> {
  const temp = `${target}.tmp`;
  await writeFile(temp, content, "utf-8");
  await rename(temp, target);
}

function memoryPath(roots: ProjectRoot[]): string {
  const keys = rootKeys(roots);
  const name = path.basename(roots[0]?.path ?? "project").replace(/[^A-Za-z0-9._-]+/g, "-");
  return path.join(memoryDir(), `${name}-${sha(keys.join("|")).slice(0, 12)}.json`);
}

function rootKeys(roots: ProjectRoot[]): string[] {
  // Windows paths are case-insensitive: D:\App and d:\app are one project.
  const norm = (p: string) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
  return roots.map((root) => `${root.role}:${norm(root.path)}`).sort();
}

function featureFor(memory: ProjectMemory, spec: SpecIdentity): FeatureRecord {
  const now = new Date().toISOString();
  let feature = memory.features.find((candidate) => candidate.specKey === spec.specKey);
  if (!feature) {
    feature = { title: spec.title, specKey: spec.specKey, startedAt: now, updatedAt: now, status: "in-progress", tasks: [] };
    memory.features.push(feature);
  }
  feature.updatedAt = now;
  return feature;
}

function renderMarkdown(memory: ProjectMemory): string {
  const lines = ["# Project map", "", ...memory.roots.map((root) => `- ${root}`), ""];
  if (memory.conventions) {
    lines.push(`## Conventions (saved ${memory.conventions.savedAt.slice(0, 10)}, reused while build files are unchanged)`, "");
    lines.push(memory.conventions.text, "");
  }
  lines.push("## Features", "");
  for (const feature of [...memory.features].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    lines.push(`### ${feature.title}`, "", `${feature.status} · started ${feature.startedAt.slice(0, 10)} · updated ${feature.updatedAt.slice(0, 10)}`, "");
    for (const task of feature.tasks) {
      lines.push(`- **${task.id}**${task.files?.length ? ` — ${task.files.join(", ")}` : ""}`, `  ${task.summary.replace(/\s+/g, " ")}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function shorten(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const end = flat.search(/[.!?](\s|$)/);
  return shorten(end === -1 ? flat : flat.slice(0, end + 1), 200);
}

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
