import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

/**
 * Filesystem listing for the UI's folder/file picker.
 *
 * Scope note: this is deliberately not sandboxed to any root. The whole job of
 * this tool is to point an AI agent at an arbitrary project directory on this
 * machine, and the server binds to loopback only (see server.ts) — a picker
 * restricted to one subtree would make choosing a target project impossible
 * without buying any security the pipeline itself doesn't already give away.
 */

export type BrowseKind = "dir" | "markdown" | "any";

export interface BrowseEntry {
  name: string;
  path: string;
  type: "dir" | "file";
}

export interface BrowseResult {
  path: string;
  parent: string | null;
  entries: BrowseEntry[];
}

export class BrowseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowseError";
  }
}

export async function browse(target: string, kind: BrowseKind = "any"): Promise<BrowseResult> {
  // An empty path means "start somewhere useful": the drive list on Windows,
  // the root on POSIX. Windows has no single filesystem root to fall back on.
  if (!target.trim()) {
    return process.platform === "win32" ? listDrives() : browse("/", kind);
  }

  const dir = path.resolve(target);
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    throw new BrowseError(`Cannot open ${dir}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const entries: BrowseEntry[] = [];
  for (const dirent of dirents) {
    if (dirent.name.startsWith(".")) continue;
    const full = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      if (dirent.name === "node_modules") continue;
      entries.push({ name: dirent.name, path: full, type: "dir" });
    } else if (dirent.isFile() && kind !== "dir" && matchesKind(dirent.name, kind)) {
      entries.push({ name: dirent.name, path: full, type: "file" });
    }
  }

  entries.sort(byFoldersThenName);

  const parent = path.dirname(dir);
  return { path: dir, parent: parent === dir ? "" : parent, entries };
}

function matchesKind(name: string, kind: BrowseKind): boolean {
  if (kind === "any") return true;
  return /\.(md|markdown|sql|txt)$/i.test(name);
}

function byFoldersThenName(a: BrowseEntry, b: BrowseEntry): number {
  if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

/** Windows drive roots, probed rather than enumerated — Node exposes no API. */
function listDrives(): BrowseResult {
  const entries: BrowseEntry[] = [];
  for (let code = "A".charCodeAt(0); code <= "Z".charCodeAt(0); code++) {
    const root = `${String.fromCharCode(code)}:\\`;
    if (existsSync(root)) entries.push({ name: root, path: root, type: "dir" });
  }
  return { path: "", parent: null, entries };
}
