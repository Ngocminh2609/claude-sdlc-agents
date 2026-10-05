import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { DbInfo } from "./types.js";

/**
 * Argument parsing for the `aidev` command, kept out of `src/index.ts` so it
 * can be tested without importing that module — which starts a pipeline run
 * as a side effect of being imported.
 */

/**
 * Where the code goes: one project folder (`--project`), or separate server
 * and client folders (`--project-be`, `--project-fe`) — not both kinds.
 */
export interface TargetArgs {
  project?: string;
  be?: string;
  fe?: string;
  /** Where database scripts go (`--project-sql`). Optional, and only alongside a code folder. */
  sql?: string;
}

export interface Args {
  specPath: string;
  target: TargetArgs;
  dbInfo?: DbInfo;
  referencePaths: string[];
  /** Ignore progress saved by a stopped run and start from the beginning. */
  fresh: boolean;
  /** Ignore the target's `.metadata-standards.yml` for this run, even if present. */
  noMetadataStandards: boolean;
}

export const USAGE =
  "Usage: aidev --spec <path.md> (--project <dir> | --project-be <dir> [--project-fe <dir>] | --project-fe <dir>) [--project-sql <dir>] [--db-connection <string> (needs --project-sql) | --db-schema <path>] [--reference <dir>]... [--fresh] [--no-metadata-standards]";

export const CLONE_USAGE =
  'Usage: aidev clone --what "<keyword>" (--from <dir>... | --from-be <dir> [--from-fe <dir>] | --from-fe <dir>) (--project <dir> | --project-be <dir> [--project-fe <dir>] | --project-fe <dir>) [--no-build] [--no-tests] [--fresh] [--no-metadata-standards]';

/** Clone mode: port an existing feature from one repo into another. */
export interface CloneArgs {
  /** A keyword, Vietnamese or English — not necessarily the feature's exact name. */
  what: string;
  target: TargetArgs;
  /** Unlabelled sources (`--from`, repeatable) plus labelled BE/FE sources. */
  from: { paths: string[]; be?: string; fe?: string };
  skipBuild: boolean;
  skipTests: boolean;
  fresh: boolean;
  /** Ignore the target's `.metadata-standards.yml` for this run, even if present. */
  noMetadataStandards: boolean;
}

export function parseCloneArgs(argv: string[]): CloneArgs {
  let what: string | undefined;
  let skipBuild = false;
  let skipTests = false;
  let fresh = false;
  let noMetadataStandards = false;
  const target: TargetArgs = {};
  const from: CloneArgs["from"] = { paths: [] };

  for (let i = 0; i < argv.length; i++) {
    if (takeTarget(argv, i, target)) {
      i++;
      continue;
    }
    switch (argv[i]) {
      case "--what":
        what = argv[++i];
        break;
      case "--from":
        from.paths.push(argv[++i]);
        break;
      case "--from-be":
        from.be = argv[++i];
        break;
      case "--from-fe":
        from.fe = argv[++i];
        break;
      case "--no-build":
        skipBuild = true;
        break;
      case "--no-tests":
        skipTests = true;
        break;
      case "--fresh":
        fresh = true;
        break;
      case "--no-metadata-standards":
        noMetadataStandards = true;
        break;
    }
  }

  const hasSource = from.paths.length > 0 || Boolean(from.be) || Boolean(from.fe);
  if (!what?.trim() || !hasTarget(target) || !hasSource) throw new Error(CLONE_USAGE);
  assertOneTargetKind(target, CLONE_USAGE);

  return { what: what.trim(), target, from, skipBuild, skipTests, fresh, noMetadataStandards };
}

export const SPEC_DRAFT_USAGE =
  'Usage: aidev spec (--request "<text>" | --request-file <path>) (--project <dir> | --project-be <dir> [--project-fe <dir>] | --project-fe <dir>) [--project-sql <dir>] --out <path.md> [--reference <dir>]... [--overwrite]';

/** `aidev spec`: draft a spec from a plain-language request, for a person to confirm. */
export interface SpecDraftArgs {
  /** Exactly one of these two is set. */
  requestText?: string;
  requestFile?: string;
  target: TargetArgs;
  outPath: string;
  referencePaths: string[];
  /** Replace an existing file at `outPath`. Without it, an existing file stops the command. */
  overwrite: boolean;
}

export function parseSpecDraftArgs(argv: string[]): SpecDraftArgs {
  let requestText: string | undefined;
  let requestFile: string | undefined;
  let outPath: string | undefined;
  let overwrite = false;
  const target: TargetArgs = {};
  const referencePaths: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    if (takeTarget(argv, i, target)) {
      i++;
      continue;
    }
    switch (argv[i]) {
      case "--request":
        requestText = argv[++i];
        break;
      case "--request-file":
        requestFile = argv[++i];
        break;
      case "--out":
        outPath = argv[++i];
        break;
      case "--reference":
        referencePaths.push(argv[++i]);
        break;
      case "--overwrite":
        overwrite = true;
        break;
    }
  }

  const hasText = Boolean(requestText?.trim());
  if (hasText === Boolean(requestFile) || !outPath || !hasTarget(target)) throw new Error(SPEC_DRAFT_USAGE);
  assertOneTargetKind(target, SPEC_DRAFT_USAGE);

  return {
    ...(hasText ? { requestText: requestText?.trim() } : { requestFile }),
    target,
    outPath,
    referencePaths,
    overwrite,
  };
}

export function parseArgs(argv: string[]): Args {
  let specPath: string | undefined;
  let dbInfo: DbInfo | undefined;
  let fresh = false;
  let noMetadataStandards = false;
  const target: TargetArgs = {};
  const referencePaths: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    if (takeTarget(argv, i, target)) {
      i++;
      continue;
    }
    switch (argv[i]) {
      case "--spec":
        specPath = argv[++i];
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
      case "--fresh":
        fresh = true;
        break;
      case "--no-metadata-standards":
        noMetadataStandards = true;
        break;
    }
  }

  if (!specPath || !hasTarget(target)) throw new Error(USAGE);
  assertOneTargetKind(target, USAGE);

  return { specPath, target, dbInfo, referencePaths, fresh, noMetadataStandards };
}

/** Consumes a target flag and its value at `i`; true when it did. */
function takeTarget(argv: string[], i: number, target: TargetArgs): boolean {
  switch (argv[i]) {
    case "--project":
      target.project = argv[i + 1];
      return true;
    case "--project-be":
      target.be = argv[i + 1];
      return true;
    case "--project-fe":
      target.fe = argv[i + 1];
      return true;
    case "--project-sql":
      target.sql = argv[i + 1];
      return true;
    default:
      return false;
  }
}

function hasTarget(target: TargetArgs): boolean {
  return Boolean(target.project || target.be || target.fe);
}

function assertOneTargetKind(target: TargetArgs, usage: string): void {
  if (target.project && (target.be || target.fe)) {
    throw new Error(`Give either --project or --project-be/--project-fe, not both.\n${usage}`);
  }
}

/**
 * Validates reference folders up front. A typo would otherwise surface much
 * later as an agent quietly finding nothing in a directory that does not
 * exist, by which point the design stage has already run and been paid for.
 */
export function resolveReferencePaths(
  referencePaths: string[],
  targetPaths: string | string[],
  flag = "--reference",
): string[] {
  const targets = (Array.isArray(targetPaths) ? targetPaths : [targetPaths]).map((target) => path.resolve(target));
  return referencePaths.map((candidate) => {
    const resolved = path.resolve(candidate);
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      throw new Error(`${flag} is not a directory: ${resolved}`);
    }
    if (targets.includes(resolved)) {
      throw new Error(`${flag} cannot be a target project folder — that is already readable.`);
    }
    return resolved;
  });
}
