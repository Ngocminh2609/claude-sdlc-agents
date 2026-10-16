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
  parseSqlOptimizeArgs,
  resolveReferencePaths,
  type Args,
  type TargetArgs,
} from "./cli-args.js";
import { checkSqlSteps, proposeSqlSteps, rejectionOf } from "./stages/sql-optimize.js";
import {
  applySteps,
  detectDialect,
  MAX_SQL_CHARS,
  optimizedPathOf,
  readSqlFile,
  renderOptimizedFile,
  writeSqlFile,
} from "./sql-file.js";
import { runSpecDraft, type SpecDraftInput } from "./stages/spec-draft.js";
import { connectDatabase, describeDatabase, parseConnection, type SqlRunner } from "./database.js";
import type { DatabaseContext } from "./database-scripts.js";
import { StageError } from "./stage-error.js";
import { assertRootsExist, buildRoots, rootsOf, type ProjectRoot } from "./target-roots.js";
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
import { setRunBudget } from "./run-budget.js";
import { onStepActivity } from "./step-activity.js";
import { loadProjectMemory } from "./project-memory.js";
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

// Steps feed the UI's mind map. At a terminal only the loop guard's
// interventions are worth a line — every turn would drown the log.
onStepActivity((report) => {
  if (streamEvents) emit({ type: "step", ...report });
  else if (report.phase === "turn" && report.note) {
    console.log(`[loop-guard] ${report.step}: ${report.note} (turn ${report.turns}/${report.maxTurns})`);
  }
});

/** Applies `--max-run-usd` and tells the UI the cap, once, before anything is spent. */
function applyRunBudget(maxRunUsd: number | undefined): void {
  setRunBudget(maxRunUsd);
  if (maxRunUsd === undefined) return;
  if (streamEvents) emit({ type: "budget", capUsd: maxRunUsd });
  else console.log(`[pipeline] Run budget: stops before the next step once ~${maxRunUsd.toFixed(2)} is spent`);
}

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
  applyRunBudget(args.maxRunUsd);

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
    const logger = new RunLogger(spec, args.specPath, { saveAsItGoes: true });
    for (const line of describeMetadataStandardsOverride(args.noMetadataStandards)) onProgress(line);
    onProgress(describeMetadataStandards(spec.metadataStandards));
    onProgress(describeSkillCatalog(spec.skillCatalog));
    spec.projectIndexes = await refreshIndexesForRun(
      [...(spec.targetRoots ?? []).map((root) => root.path), ...(spec.referencePaths ?? [])],
      onProgress,
    );

    spec.projectMemory = await loadProjectMemory(rootsOf(spec));

    process.chdir(spec.projectPath);

    const result = await runPipeline({ spec, logger, onProgress, fresh: args.fresh, sqlRunner, answers: args.answers });
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
      ? /password authentication failed/i.test(reason)
        ? ` — the server refused the password for user "${target.user ?? "?"}". Check it against the one the database was created with; in a URL, @ # / ? : % must be URL-encoded.`
        : ""
      : " — no password was found in the connection string. Put it in, e.g. postgresql://user:password@host:5432/db or jdbc:postgresql://host:5432/db?user=…&password=… (URL-encode @ # / ? : % in the password).";
    throw new StageError(`Database: could not connect to ${description}: ${masked}${hint}`);
  }
}

async function runClone(argv: string[]): Promise<void> {
  const args = parseCloneArgs(argv);
  applyRunBudget(args.maxRunUsd);
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
  const logger = new CloneRunLogger(clone, { saveAsItGoes: true });
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
 * `aidev sql-optimize --file x.sql` — writes `x_optimized.sql` next to it. The
 * original is never written. Three steps, each reported as it happens:
 * 1. an agent proposes edits (exact code before → after, per query);
 * 2. a second, independent agent checks each one keeps the results and side
 *    effects the same — an edit it does not confirm is dropped;
 * 3. plain code applies the confirmed edits in order. Code no edit names
 *    cannot change, so business logic outside the listed edits is untouched.
 * The file header and the UI show every step with its before/after.
 */
async function runSqlOptimizeCommand(argv: string[]): Promise<void> {
  const args = parseSqlOptimizeArgs(argv);
  const file = path.resolve(args.file);
  if (!existsSync(file)) throw new Error(`SQL file not found: ${file}`);
  const outPath = optimizedPathOf(file);
  // Checked before the agent runs: refusing afterwards would throw away a paid answer.
  if (existsSync(outPath) && !args.overwrite) {
    throw new Error(`${outPath} already exists. Pass --overwrite to replace it.`);
  }
  const source = await readSqlFile(file);
  if (!source.text.trim()) return report("errored", `SQL file is empty: ${file}`);
  if (source.text.length > MAX_SQL_CHARS) {
    return report(
      "errored",
      `SQL file is ${source.text.length.toLocaleString("en-US")} characters; this demo handles up to ${MAX_SQL_CHARS.toLocaleString("en-US")}. Split it and optimize the parts.`,
    );
  }

  const detected = args.dialect ?? detectDialect(source.text);
  onProgress(
    `SQL optimize: ${path.basename(file)} — ${source.text.length.toLocaleString("en-US")} characters, dialect ${
      args.dialect ? `${args.dialect} (chosen)` : (detected ?? "not detected, the model decides")
    }`,
  );
  onProgress(
    args.instructions
      ? "SQL optimize: mode — performance, plus only the logic changes you requested"
      : "SQL optimize: mode — performance only, business logic must stay exactly the same",
  );
  const input = {
    sql: source.text,
    fileName: path.basename(file),
    dialect: detected,
    dialectChosen: Boolean(args.dialect),
    ...(args.instructions ? { instructions: args.instructions } : {}),
  };

  let proposal;
  let checks;
  try {
    onProgress("SQL optimize: proposing edits — each one names its query and the exact code before and after");
    proposal = await proposeSqlSteps(input);
    const total = proposal.steps.length;
    onProgress(`SQL optimize: ${total} edit(s) proposed`);
    proposal.steps.forEach((step, index) =>
      onProgress(`SQL optimize: step ${index + 1}/${total} proposed — ${step.statement} — ${step.title}`),
    );
    if (total) onProgress(`SQL optimize: independent check of ${total} edit(s) — do the results stay exactly the same?`);
    checks = total ? await checkSqlSteps(input, proposal.steps) : new Map();
  } catch (error) {
    // Fail-closed: without a check, nothing is applied and no file is written.
    if (error instanceof StageError) return report("errored", `${error.message}\nNo file was written.`);
    throw error;
  }

  const numbered = proposal.steps.map((step, index) => ({
    ...step,
    index: index + 1,
    ...(checks.get(index + 1) ? { check: checks.get(index + 1) } : {}),
  }));
  const rejected = new Map<number, string>();
  for (const step of numbered) {
    const reason = rejectionOf(step, step.check, args.instructions);
    if (reason) rejected.set(step.index, reason);
  }
  const { text, outcomes } = applySteps(source.text, numbered, rejected);
  for (const step of outcomes) {
    onProgress(
      step.status === "applied"
        ? `SQL optimize: step ${step.index}/${outcomes.length} applied (${step.edits.length} edit(s), line ${step.lines?.join(", ")}) — ${step.title}`
        : `SQL optimize: step ${step.index}/${outcomes.length} NOT applied — ${step.rejectedBecause}`,
    );
  }

  const optimizationReport = {
    dialect: proposal.dialect,
    steps: outcomes,
    warnings: proposal.warnings,
    indexSuggestions: proposal.indexSuggestions,
  };
  await writeSqlFile(outPath, renderOptimizedFile(optimizationReport, text, file), source);
  onProgress(`SQL optimize: written to ${outPath}`);
  if (streamEvents) {
    emit({
      type: "sql-steps",
      outputPath: outPath,
      steps: outcomes.map(({ check, ...step }) => ({
        ...step,
        ...(check ? { verdict: check.verdict, verdictReason: check.reason } : {}),
      })),
    });
  }

  const applied = outcomes.filter((step) => step.status === "applied");
  report(
    "done",
    [
      `Optimized file written to ${outPath} (${proposal.dialect}). The original is unchanged.`,
      `${applied.length} of ${outcomes.length} proposed edit(s) applied; every other line is the original.`,
      ...outcomes.flatMap((step) => [
        "",
        `Step ${step.index} [${step.status === "applied" ? `applied, line ${step.lines?.join(", ")}` : "NOT applied"}] ${step.title}`,
        `  Query: ${step.statement}`,
        ...(step.status === "rejected" ? [`  Not applied because: ${step.rejectedBecause}`] : []),
        `  Faster because: ${step.why}`,
        `  Same results because: ${step.equivalence}`,
        ...step.edits.flatMap((edit, position) => [
          `  Before${step.edits.length > 1 ? ` ${position + 1}/${step.edits.length}` : ""}:`,
          ...edit.before.trim().split(/\r?\n/).map((line) => `    ${line}`),
          "  After:",
          ...edit.after.trim().split(/\r?\n/).map((line) => `    ${line}`),
        ]),
      ]),
      ...(proposal.warnings.length ? ["", "Check before use:", ...proposal.warnings.map((warning) => `- ${warning}`)] : []),
      ...(proposal.indexSuggestions.length
        ? ["", `Index suggestions (${proposal.indexSuggestions.length}, not applied) are in the file header.`]
        : []),
    ].join("\n"),
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
  if (argv[0] === "sql-optimize") return runSqlOptimizeCommand(argv.slice(1));
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
