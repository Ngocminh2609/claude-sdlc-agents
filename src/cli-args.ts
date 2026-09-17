import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { DbInfo } from "./types.js";

/**
 * Argument parsing for the `aidev` command, kept out of `src/index.ts` so it
 * can be tested without importing that module — which starts a pipeline run
 * as a side effect of being imported.
 */

export interface Args {
  specPath: string;
  projectPath: string;
  dbInfo?: DbInfo;
  referencePaths: string[];
}

export const USAGE =
  "Usage: aidev --spec <path.md> --project <path> [--db-connection <string> | --db-schema <path>] [--reference <dir>]...";

export const CLONE_USAGE =
  'Usage: aidev clone --what "<feature>" --from <dir> [--from <dir>]... --project <dir> [--no-build]';

/** Clone mode: port an existing feature from one repo into another. */
export interface CloneArgs {
  what: string;
  fromPaths: string[];
  projectPath: string;
  skipBuild: boolean;
}

export function parseCloneArgs(argv: string[]): CloneArgs {
  let what: string | undefined;
  let projectPath: string | undefined;
  let skipBuild = false;
  const fromPaths: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--what":
        what = argv[++i];
        break;
      case "--from":
        fromPaths.push(argv[++i]);
        break;
      case "--project":
        projectPath = argv[++i];
        break;
      case "--no-build":
        skipBuild = true;
        break;
    }
  }

  if (!what?.trim() || !projectPath || !fromPaths.length) throw new Error(CLONE_USAGE);

  return { what: what.trim(), fromPaths, projectPath, skipBuild };
}

export function parseArgs(argv: string[]): Args {
  let specPath: string | undefined;
  let projectPath: string | undefined;
  let dbInfo: DbInfo | undefined;
  const referencePaths: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--spec":
        specPath = argv[++i];
        break;
      case "--project":
        projectPath = argv[++i];
        break;
      case "--db-connection":
        dbInfo = { kind: "connection", value: argv[++i] };
        break;
      case "--db-schema":
        dbInfo = { kind: "schema-file", value: argv[++i] };
        break;
      // Repeatable: several sample projects can be consulted in one run.
      case "--reference":
        referencePaths.push(argv[++i]);
        break;
    }
  }

  if (!specPath || !projectPath) throw new Error(USAGE);

  return { specPath, projectPath, dbInfo, referencePaths };
}

/**
 * Validates `--reference` up front. A typo would otherwise surface much later
 * as an agent quietly finding nothing in a directory that does not exist, by
 * which point the design stage has already run and been paid for.
 */
export function resolveReferencePaths(
  referencePaths: string[],
  projectPath: string,
  flag = "--reference",
): string[] {
  return referencePaths.map((candidate) => {
    const resolved = path.resolve(candidate);
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      throw new Error(`${flag} is not a directory: ${resolved}`);
    }
    if (resolved === path.resolve(projectPath)) {
      throw new Error(`${flag} cannot be the target project — that is already readable.`);
    }
    return resolved;
  });
}
