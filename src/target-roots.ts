import { existsSync, statSync } from "node:fs";
import path from "node:path";

/**
 * The folders a run works in, and what each one holds.
 *
 * A project is either one folder holding everything ("app") or a separate
 * server folder ("be") and client folder ("fe") — often two repos in different
 * places. Separate folders also let a run look only where the code is, instead
 * of scanning a whole monorepo root, which costs turns and tokens.
 *
 * The first root is where the pipeline runs (its working directory); the
 * others are opened to the agent with the SDK's `additionalDirectories`, the
 * same way reference repos are, but writable.
 */
export type RootRole = "be" | "fe" | "app";

export interface ProjectRoot {
  role: RootRole;
  path: string;
}

const ROLE_LABEL: Record<RootRole, string> = {
  be: "BE (server, database scripts)",
  fe: "FE (client)",
  app: "whole project",
};

/**
 * Builds roots from what the user chose. BE and FE given as the same folder
 * collapse into one "app" root — a repo holding both is just one project.
 * BE comes first, since the build and the database usually live there.
 */
export function buildRoots(input: { project?: string; be?: string; fe?: string }): ProjectRoot[] {
  const app = resolved(input.project);
  const be = resolved(input.be);
  const fe = resolved(input.fe);

  if (app && (be || fe)) {
    throw new Error("Give either one project folder or separate BE/FE folders, not both.");
  }
  if (app) return [{ role: "app", path: app }];
  if (be && fe && samePath(be, fe)) return [{ role: "app", path: be }];

  const roots: ProjectRoot[] = [];
  if (be) roots.push({ role: "be", path: be });
  if (fe) roots.push({ role: "fe", path: fe });
  return roots;
}

export function assertRootsExist(roots: ProjectRoot[], what: string): void {
  for (const root of roots) {
    if (!existsSync(root.path) || !statSync(root.path).isDirectory()) {
      throw new Error(`${what} (${root.role}) is not a directory: ${root.path}`);
    }
  }
}

/** The roots of an input that may predate separate folders: one "app" root then. */
export function rootsOf(input: { projectPath: string; targetRoots?: ProjectRoot[] }): ProjectRoot[] {
  return input.targetRoots?.length ? input.targetRoots : [{ role: "app", path: input.projectPath }];
}

/** Every root but the working directory — what the agent needs opened on top of it. */
export function secondaryRootDirs(roots: ProjectRoot[]): string[] {
  return roots.slice(1).map((root) => root.path);
}

/** The folder a role lives in; the working directory when the role is absent or unknown. */
export function rootPath(roots: ProjectRoot[], role?: RootRole): string {
  return (role && roots.find((root) => root.role === role)?.path) || roots[0].path;
}

export function isSplit(roots: ProjectRoot[]): boolean {
  return roots.length > 1 || (roots[0] !== undefined && roots[0].role !== "app");
}

/**
 * Prompt block naming the target folders. Empty for a single-folder project,
 * so those runs read exactly as they did before separate folders existed.
 */
export function targetRootsPromptSection(roots: ProjectRoot[]): string[] {
  if (!isSplit(roots)) return [];
  return [
    "",
    "--- Target project folders ---",
    ...roots.map((root) => `- ${ROLE_LABEL[root.role]}: ${root.path}`),
    "",
    `This project is split into separate folders. Your working directory is the first one (${roots[0].path}).`,
    "Server code and database scripts belong in the BE folder, client code in the FE folder. Run each",
    "side's build and test commands from inside its own folder (cd into it), and give every path you",
    "report relative to the folder it lives in, saying which folder that is.",
  ];
}

/** Prompt block naming labelled reference folders, when the references are labelled at all. */
export function referenceRootsPromptSection(roots: ProjectRoot[]): string[] {
  if (!isSplit(roots)) return [];
  return [
    "",
    "--- Reference folders by role (READ-ONLY) ---",
    ...roots.map((root) => `- ${ROLE_LABEL[root.role]}: ${root.path}`),
    "Look for server code and database scripts in the BE folder and client code in the FE folder.",
  ];
}

function resolved(candidate: string | undefined): string | null {
  return candidate?.trim() ? path.resolve(candidate.trim()) : null;
}

function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
