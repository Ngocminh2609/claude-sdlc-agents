import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseArgs, parseCloneArgs, resolveReferencePaths, type Args } from "./cli-args.js";
import { missingBuildManifestWarning } from "./clone-build-manifest-check.js";
import { runClonePipeline } from "./clone-pipeline.js";
import { encodeEvent, eventStreamEnabled, type PipelineEvent } from "./events.js";
import { runPipeline } from "./pipeline.js";
import { CloneRunLogger, RunLogger } from "./run-log.js";
import type { CloneInput, SpecInput } from "./types.js";

async function loadSpec(args: Args): Promise<SpecInput> {
  const specMarkdown = await readFile(args.specPath, "utf-8");
  const projectPath = path.resolve(args.projectPath);

  let dbInfo = args.dbInfo;
  if (dbInfo?.kind === "schema-file") {
    const schemaContent = await readFile(dbInfo.value, "utf-8");
    dbInfo = { kind: "schema-file", value: schemaContent };
  }

  const referencePaths = resolveReferencePaths(args.referencePaths, projectPath);

  return { specMarkdown, projectPath, dbInfo, referencePaths };
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

function report(status: string, message: string, logPath?: string): void {
  if (streamEvents) {
    emit({ type: "finished", status, message, ...(logPath ? { logPath } : {}) });
  } else {
    console.log(`\nPipeline finished with status: ${status}`);
    console.log(message);
    if (logPath) console.log(`\nFull run log: ${logPath}`);
  }
  if (status !== "done") process.exitCode = 1;
}

async function runFeature(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const spec = await loadSpec(args);
  const logger = new RunLogger(spec, args.specPath);

  process.chdir(spec.projectPath);

  const result = await runPipeline({ spec, logger, onProgress, fresh: args.fresh });
  report(result.status, result.message, result.logPath);
}

async function runClone(argv: string[]): Promise<void> {
  const args = parseCloneArgs(argv);
  const projectPath = path.resolve(args.projectPath);
  const clone: CloneInput = {
    what: args.what,
    projectPath,
    referencePaths: resolveReferencePaths(args.fromPaths, projectPath, "--from"),
  };
  const logger = new CloneRunLogger(clone);

  // Advisory only — narrowing --project to cut exploration is good practice
  // (same principle --from's own guidance already applies), but narrowed past
  // the project's own build boundary the Clone Build stage has nothing to
  // build from, and that fails late rather than up front. Skipped entirely
  // under --no-build: there is nothing to warn about if it won't run.
  if (!args.skipBuild) {
    const warning = missingBuildManifestWarning(clone.projectPath);
    if (warning) onProgress(`Warning: ${warning}`);
  }

  // Same contract as the feature pipeline: stages operate on the process
  // working directory, so the target project has to be it.
  process.chdir(clone.projectPath);

  const result = await runClonePipeline({
    clone,
    logger,
    onProgress,
    skipBuild: args.skipBuild,
    fresh: args.fresh,
  });
  report(result.status, result.message, result.logPath);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "clone") return runClone(argv.slice(1));
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
