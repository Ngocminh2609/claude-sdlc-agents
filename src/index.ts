import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { describeUsage, onUsage, usageSoFar } from "./token-usage.js";
import { refreshIndexesForRun, refreshProjectIndexes } from "./project-index.js";
import {
  parseArgs,
  parseCloneArgs,
  parseSpecDraftArgs,
  resolveReferencePaths,
  type Args,
  type TargetArgs,
} from "./cli-args.js";
import { runSpecDraft, type SpecDraftInput } from "./stages/spec-draft.js";
import { connectDatabase, describeDatabase, parseConnection, type SqlRunner } from "./database.js";
import type { DatabaseContext } from "./database-scripts.js";
import { StageError } from "./stage-error.js";
import { assertRootsExist, buildRoots, type ProjectRoot } from "./target-roots.js";
import { missingBuildManifestWarning } from "./clone-build-manifest-check.js";
import { runClonePipeline } from "./clone-pipeline.js";
import { encodeEvent, eventStreamEnabled, type PipelineEvent } from "./events.js";
import { config } from "./config.js";
import {
  describeMetadataStandards,
  describeMetadataStandardsOverride,
  loadMetadataStandards,
  metadataStandardsFor,
} from "./metadata-standards.js";
import { runPipeline } from "./pipeline.js";
import { describeSkillCatalog, loadSkillCatalog, relevantSkillCatalog } from "./skills-catalog.js";
import { CloneRunLogger, RunLogger } from "./run-log.js";
import type { CloneInput, SpecInput } from "./types.js";

async function loadSpec(args: Args): Promise<SpecInput> {
  const specMarkdown = await readFile(args.specPath, "utf-8");
  const targetRoots = targetRootsFrom(args.target);

  let dbInfo = args.dbInfo;
  if (dbInfo?.kind === "schema-file") {
    const schemaContent = await readFile(dbInfo.value, "utf-8");
    dbInfo = { kind: "schema-file", value: schemaContent };
  } else if (dbInfo?.kind === "connection") {
    // The connection string stays in `runFeature`, which opens it. What the
    // stages learn about the database comes from `spec.database`, credential-free.
    dbInfo = { kind: "connection", value: "" };
  }

  const referencePaths = resolveReferencePaths(
    args.referencePaths,
    targetRoots.map((root) => root.path),
  );

  return {
    specMarkdown,
    projectPath: targetRoots[0].path,
    targetRoots,
    dbInfo,
    referencePaths,
    metadataStandards: metadataStandardsFor(targetRoots, args.noMetadataStandards),
    skillCatalog: relevantSkillCatalog(loadSkillCatalog(targetRoots), specMarkdown, config.maxSkills),
  };
}

function targetRootsFrom(target: TargetArgs): ProjectRoot[] {
  const roots = buildRoots(target);
  assertRootsExist(roots, "Target project folder");
  return roots;
}

// Off unless a front end asked for it (see src/events.ts). Read once at
// startup so a single run can't switch output shape halfway through.
const streamEvents = eventStreamEnabled();

function emit(event: PipelineEvent): void {
  process.stdout.write(encodeEvent(event));
}

const onProgress = (message: string): void => {
  if (streamEvents) emit({ type: "progress", message });
  else console.log(`[pipeline] ${message}`);
};

// The UI attributes each increase to the stage active when it arrives.
if (streamEvents) onUsage((total) => emit({ type: "usage", total }));

function report(status: string, message: string, logPath?: string): void {
  if (streamEvents) {
    emit({ type: "finished", status, message, ...(logPath ? { logPath } : {}) });
  } else {
    console.log(`\nPipeline finished with status: ${status}`);
    console.log(message);
    console.log(`\nToken usage: ${describeUsage(usageSoFar())}`);
    if (logPath) console.log(`\nFull run log: ${logPath}`);
  }
  if (status !== "done") process.exitCode = 1;
}

async function runFeature(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const spec = await loadSpec(args);

  // Checked first, before anything is spent: a wrong password should cost a
  // second, not a design round.
  let sqlRunner: SqlRunner | undefined;
  if (args.dbInfo?.kind === "connection") {
    try {
      const opened = await openDatabase(args.dbInfo.value, spec.targetRoots ?? []);
      spec.database = opened.database;
      sqlRunner = opened.runner;
    } catch (error) {
      if (error instanceof StageError) return report("errored", error.message);
      throw error;
    }
    onProgress(`Database check: connected to ${spec.database.description}; new scripts in ${spec.database.scriptsDir} will be applied after each task`);
  }

  try {
    const logger = new RunLogger(spec, args.specPath);
    for (const line of describeMetadataStandardsOverride(args.noMetadataStandards)) onProgress(line);
    onProgress(describeMetadataStandards(spec.metadataStandards));
    onProgress(describeSkillCatalog(spec.skillCatalog));
    spec.projectIndexes = await refreshIndexesForRun(
      [...(spec.targetRoots ?? []).map((root) => root.path), ...(spec.referencePaths ?? [])],
      onProgress,
    );

    process.chdir(spec.projectPath);

    const result = await runPipeline({ spec, logger, onProgress, fresh: args.fresh, sqlRunner });
    report(result.status, result.message, result.logPath);
  } finally {
    await sqlRunner?.close().catch(() => {});
  }
}

/**
 * Connects to the user's database and says where its scripts live. Every
 * failure is a StageError worded for the user — with the password, should a
 * driver ever echo it, masked out.
 */
async function openDatabase(
  connection: string,
  roots: ProjectRoot[],
): Promise<{ database: DatabaseContext; runner: SqlRunner }> {
  const sqlRoot = roots.find((root) => root.role === "sql");
  if (!sqlRoot) {
    throw new StageError(
      "Database: a connection was given without a SQL folder (--project-sql). The scripts to run need a folder of their own.",
    );
  }
  const target = parseConnection(connection);
  const description = describeDatabase(target);
  try {
    const runner = await connectDatabase(target);
    return { database: { dialect: target.dialect, description, scriptsDir: sqlRoot.path }, runner };
  } catch (error) {
    if (error instanceof StageError) throw error;
    console.error("Database connection failed:", error);
    const reason = error instanceof Error ? error.message : String(error);
    const masked = target.password ? reason.split(target.password).join("***") : reason;
    // A Spring-style URL (credentials kept in separate properties) reached the driver as
    // "client password must be a string" on a real run, which said nothing about the cause.
    const hint = target.password
      ? ""
      : " — no password was found in the connection string. Put it in, e.g. postgresql://user:password@host:5432/db or jdbc:postgresql://host:5432/db?user=…&password=… (URL-encode @ # / ? : % in the password).";
    throw new StageError(`Database: could not connect to ${description}: ${masked}${hint}`);
  }
}

async function runClone(argv: string[]): Promise<void> {
  const args = parseCloneArgs(argv);
  const targetRoots = targetRootsFrom(args.target);
  const targetPaths = targetRoots.map((root) => root.path);

  // Unlabelled --from sources stay role-less; --from-be / --from-fe are
  // labelled so every stage is told which folder holds the server and which
  // the client. Same folder given for both collapses to one.
  const labelled = buildRoots({ be: args.from.be, fe: args.from.fe });
  const unlabelled = resolveReferencePaths(args.from.paths, targetPaths, "--from").map((reference) => ({
    role: "app" as const,
    path: reference,
  }));
  const referenceRoots: ProjectRoot[] = [
    ...labelled.map((root) => ({ ...root, path: resolveReferencePaths([root.path], targetPaths, "--from")[0] })),
    ...unlabelled,
  ];

  const clone: CloneInput = {
    what: args.what,
    projectPath: targetRoots[0].path,
    targetRoots,
    referencePaths: referenceRoots.map((root) => root.path),
    referenceRoots,
    metadataStandards: metadataStandardsFor(targetRoots, args.noMetadataStandards),
    skillCatalog: relevantSkillCatalog(loadSkillCatalog(targetRoots), args.what, config.maxSkills),
  };
  const logger = new CloneRunLogger(clone);
  for (const line of describeMetadataStandardsOverride(args.noMetadataStandards)) onProgress(line);
  onProgress(describeMetadataStandards(clone.metadataStandards));
  onProgress(describeSkillCatalog(clone.skillCatalog));

  // Advisory only — narrowing a target folder to cut exploration is good
  // practice, but narrowed past its own build boundary the Clone Build stage
  // has nothing to build from, and that fails late rather than up front.
  // Checked per folder: BE and FE each build on their own. Skipped entirely
  // under --no-build: there is nothing to warn about if it won't run.
  if (!args.skipBuild) {
    // A SQL folder holds scripts, not a build.
    for (const root of targetRoots.filter((candidate) => candidate.role !== "sql")) {
      const warning = missingBuildManifestWarning(root.path);
      if (warning) onProgress(`Warning: ${warning}`);
    }
  }

  clone.projectIndexes = await refreshIndexesForRun([...targetPaths, ...clone.referencePaths], onProgress);

  // Same contract as the feature pipeline: stages operate on the process
  // working directory, so the target project has to be it.
  process.chdir(clone.projectPath);

  const result = await runClonePipeline({
    clone,
    logger,
    onProgress,
    skipBuild: args.skipBuild,
    skipTests: args.skipTests,
    fresh: args.fresh,
  });
  report(result.status, result.message, result.logPath);
}

/**
 * `aidev spec` — drafts a spec from a plain-language request and writes it to
 * `--out`, then stops. It never starts the feature pipeline itself: the draft
 * is for a person to read, correct and confirm, and only then does
 * `aidev --spec <out>` (or the UI's confirm button) build from it.
 */
async function runSpecDraftCommand(argv: string[]): Promise<void> {
  const args = parseSpecDraftArgs(argv);
  // Resolved before the chdir below, so a relative --out means the caller's folder.
  const outPath = path.resolve(args.outPath);
  // Checked before any agent runs: refusing afterwards would throw away a paid draft.
  if (existsSync(outPath) && !args.overwrite) {
    throw new Error(`--out already exists: ${outPath}. Pick another path or pass --overwrite.`);
  }
  const request = args.requestText ?? (await readFile(args.requestFile as string, "utf-8"));
  const targetRoots = targetRootsFrom(args.target);
  const referencePaths = resolveReferencePaths(
    args.referencePaths,
    targetRoots.map((root) => root.path),
  );

  const input: SpecDraftInput = {
    request,
    projectPath: targetRoots[0].path,
    targetRoots,
    referencePaths,
    skillCatalog: relevantSkillCatalog(loadSkillCatalog(targetRoots), request, config.maxSkills),
  };
  onProgress(describeSkillCatalog(input.skillCatalog));
  input.projectIndexes = await refreshIndexesForRun(
    [...targetRoots.map((root) => root.path), ...referencePaths],
    onProgress,
  );

  process.chdir(input.projectPath);

  onProgress("Spec draft: reading the project and drafting the spec from the request");
  let markdown: string;
  try {
    markdown = await runSpecDraft(input);
  } catch (error) {
    if (error instanceof StageError) return report("errored", error.message);
    throw error;
  }

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, markdown, "utf-8");
  onProgress(`Spec draft: written to ${outPath}`);
  report(
    "done",
    `Spec draft written to ${outPath}. Read it, correct it (check the open questions and every "(giả định)"), then build it with: aidev --spec "${outPath}" and the same target folders.`,
  );
}

/**
 * `aidev index <folder>...` — build or refresh the project indexes ahead of a
 * run (every run also refreshes them itself; this is for doing it up front
 * and seeing what they hold).
 */
async function runIndex(argv: string[]): Promise<void> {
  const folders = argv.filter((arg) => !arg.startsWith("--"));
  if (!folders.length) throw new Error("Usage: aidev index <folder>...");
  const started = Date.now();
  const repos = await refreshProjectIndexes(folders);
  for (const repo of repos) {
    console.log(
      `${repo.repoRoot}: ${repo.fileCount} file(s), ${repo.rebuilt ? "built from scratch" : `${repo.changedFiles} changed file(s) re-indexed`} — ${repo.indexFile}`,
    );
  }
  console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "clone") return runClone(argv.slice(1));
  if (argv[0] === "index") return runIndex(argv.slice(1));
  if (argv[0] === "spec") return runSpecDraftCommand(argv.slice(1));
  return runFeature(argv);
}

main().catch((error) => {
  // The detail goes to stderr either way — a front end shows it as log output.
  // The event carries only the generic message, matching what runPipeline
  // already does for an unexpected throw inside the pipeline.
  console.error("Pipeline crashed:", error);
  if (streamEvents) {
    emit({
      type: "crashed",
      message: "An unexpected error occurred. Check the run output for details.",
    });
  }
  process.exitCode = 1;
});
