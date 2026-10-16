import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SqlOptimizeArgs } from "./cli-args.js";
import { describeDatabase, parseConnection } from "./database.js";
import type { SqlFileView } from "./events.js";
import { StageError } from "./stage-error.js";
import { checkSqlSteps, proposeSqlSteps, rejectionOf } from "./stages/sql-optimize.js";
import {
  applySteps,
  detectDialect,
  logicReferences,
  maxSqlChars,
  optimizedPathOf,
  readSqlFile,
  renderOptimizedFile,
  sqlFilesOf,
  writeSqlFile,
  type OptimizeDialect,
  type StepOutcome,
} from "./sql-file.js";
import { planFileFor, readPlanFile, type PlanSummary } from "./sql-plan.js";
import { splitSqlChunks } from "./sql-chunks.js";
import { assertRunBudget, RunBudgetError, runBudget } from "./run-budget.js";
import { openProbe, type ProbeRun, type SqlProbe } from "./sql-probe.js";
import { applyStepsVerified, parseTestCalls, testPlanFor } from "./sql-verify.js";

/**
 * `aidev sql-optimize` — one SQL file, or every `.sql` file of a folder. Per
 * file: propose steps → independent check → reference guard → (with a test
 * database) run each step and keep it only on identical results → write
 * `<name>_optimized.sql`. Every step is reported as it happens, sent to the UI,
 * written into the output header and into a run record under runs/ that the
 * UI's history lists.
 */

export interface CommandIo {
  onProgress(message: string): void;
  /** Sends the per-file step view to the UI (event stream only). */
  emitFiles(files: SqlFileView[]): void;
  report(status: string, message: string, logPath?: string): void;
}

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNS_DIR = () => process.env.AIDEV_RUNS_DIR ?? path.join(TOOL_ROOT, "runs");
const MAX_SCHEMA_CHARS = 20_000;


export async function runSqlOptimize(args: SqlOptimizeArgs, io: CommandIo): Promise<void> {
  const started = new Date();
  const files = sqlFilesOf(args.file);
  if (!files.length) return io.report("errored", `No .sql file in ${path.resolve(args.file)}.`);
  // Checked before any agent runs: refusing afterwards would throw away paid answers.
  const existing = files.map(optimizedPathOf).filter((out) => existsSync(out));
  if (existing.length && !args.overwrite) {
    throw new Error(`${existing.length} output file(s) already exist (${existing[0]}…). Pass --overwrite to replace them.`);
  }
  if (args.planPath && !existsSync(path.resolve(args.planPath))) throw new Error(`Execution plan not found: ${path.resolve(args.planPath)}`);
  if (args.planPath && files.length > 1 && statSync(path.resolve(args.planPath)).isFile()) {
    throw new Error("One plan file was given for a folder of SQL files: give a folder of plans named like the SQL files (orders.sql ↔ orders.sqlplan).");
  }
  const calls = parseTestCalls(args.testCalls);
  const givenSchema = args.schemaFile ? await readFile(path.resolve(args.schemaFile), "utf-8") : "";

  let probe: SqlProbe | null = null;
  if (args.verifyDb) {
    const target = parseConnection(args.verifyDb);
    io.onProgress(`SQL verify: connecting to the TEST database ${describeDatabase(target)}`);
    try {
      probe = await openProbe(target);
    } catch (error) {
      const reason = error instanceof Error ? error.message.split(target.password ?? "\u0000").join("***") : String(error);
      return io.report("errored", `SQL verify: could not connect to ${describeDatabase(target)}: ${reason}\nNo file was written.`);
    }
  }

  const views: SqlFileView[] = [];
  const lines: string[] = [];
  try {
    for (const [position, file] of files.entries()) {
      if (files.length > 1) io.onProgress(`SQL optimize: file ${position + 1}/${files.length} — ${path.basename(file)}`);
      const view = await optimizeOne(file, args, { calls, givenSchema, probe }, io);
      views.push(view);
      io.emitFiles(views);
      lines.push(summaryOf(view));
    }
  } finally {
    await probe?.close().catch(() => {});
  }

  const failed = views.filter((view) => view.error);
  const status = views.some((view) => view.budgetStopped) ? "budget-stopped" : failed.length === views.length ? "errored" : "done";
  const message = [
    files.length > 1 ? `${views.length - failed.length} of ${views.length} file(s) optimized.` : "",
    ...lines,
  ]
    .filter(Boolean)
    .join("\n\n");
  const logPath = await writeRunRecord(args, views, status, message, started).catch(() => undefined);
  io.report(status, message, logPath);
}

interface Context {
  calls: string[];
  givenSchema: string;
  probe: SqlProbe | null;
}

async function optimizeOne(file: string, args: SqlOptimizeArgs, context: Context, io: CommandIo): Promise<SqlFileView> {
  const outPath = optimizedPathOf(file);
  const base: SqlFileView = { source: file, outputPath: null, steps: [] };

  // 1/4 — the execution plan, when there is one: where the time really goes.
  const planFile = planFileFor(args.planPath, file);
  let executionPlan: PlanSummary | null = null;
  if (planFile) {
    io.onProgress(`SQL optimize: 1/4 reading the execution plan — ${path.basename(planFile)}`);
    try {
      executionPlan = await readPlanFile(planFile);
      io.onProgress(`SQL optimize: plan read (${executionPlan.format}, ${executionPlan.operators} operator(s)) — hotspots go to the optimizer`);
    } catch (error) {
      io.onProgress(`SQL optimize: could not read the plan (${error instanceof Error ? error.message : String(error)}) — continuing without it`);
    }
  } else {
    io.onProgress(`SQL optimize: 1/4 no execution plan${args.planPath ? ` matching ${path.basename(file)}` : ""} — optimizing from the code alone`);
  }

  // A spent budget leaves the rest of a folder untouched rather than writing copies of the originals.
  const spent = budgetReached(`${path.basename(file)}`);
  if (spent) return { ...base, error: `not optimized — ${spent}`, budgetStopped: true };

  // 2/4 — the SQL file itself.
  io.onProgress(`SQL optimize: 2/4 reading ${path.basename(file)}`);
  const limit = maxSqlChars();
  // Checked on bytes first: a file past the ceiling cannot even be read into one string.
  if (statSync(file).size > limit * 2) {
    return { ...base, error: `${statSync(file).size.toLocaleString("en-US")} bytes; the limit is ${limit.toLocaleString("en-US")} characters` };
  }
  const source = await readSqlFile(file);
  if (!source.text.trim()) return { ...base, error: "the file is empty" };
  if (source.text.length > limit) {
    return { ...base, error: `${source.text.length.toLocaleString("en-US")} characters; the limit is ${limit.toLocaleString("en-US")}` };
  }

  const detected = args.dialect ?? executionPlan?.dialect ?? detectDialect(source.text);
  io.onProgress(
    `SQL optimize: ${path.basename(file)} — ${source.text.length.toLocaleString("en-US")} characters, dialect ${
      args.dialect ? `${args.dialect} (chosen)` : (detected ?? "not detected, the model decides")
    }`,
  );
  io.onProgress(
    args.instructions
      ? "SQL optimize: mode — performance, plus only the logic changes you requested"
      : "SQL optimize: mode — performance only, business logic must stay exactly the same",
  );

  const schema = await schemaFor(source.text, context, io);
  const common = {
    dialect: detected,
    dialectChosen: Boolean(args.dialect),
    ...(args.instructions ? { instructions: args.instructions } : {}),
    ...(schema ? { schema } : {}),
    ...(executionPlan ? { plan: executionPlan.text } : {}),
  };

  // A large file goes part by part (routines, batches); the parts reassemble into one file.
  const chunks = splitSqlChunks(source.text);
  const parts = chunks.map((chunk) => source.text.slice(chunk.start, chunk.end));
  if (chunks.length > 1) {
    io.onProgress(`SQL optimize: ${chunks.length} part(s) — each is optimized and checked on its own, then they are put back together`);
    io.onProgress(
      `SQL optimize: about ${chunks.length * 2} AI call(s) for this file (propose + check per part)${runBudget() ? `, stopping once ~$${runBudget()?.toFixed(2)} is spent` : " — set a budget to cap the cost"}`,
    );
  }

  const testPlan = context.probe ? testPlanFor(source.text, context.calls) : null;
  const verifying = Boolean(context.probe && testPlan && !("skip" in testPlan) && context.probe.dialect !== "mysql");
  let baseline: ProbeRun | undefined;
  let baselineMs = 0;
  let keptMs: number | undefined;
  let baselineError: string | undefined;

  const outcomes: StepOutcome[] = [];
  const warnings: string[] = [];
  const indexSuggestions: string[] = [];
  let dialect = detected;
  let failedParts = 0;
  let budgetStopped = false;

  io.onProgress("SQL optimize: 3/4 optimizing — proposing steps, each naming its query and the exact code before and after");
  for (const [i, chunk] of chunks.entries()) {
    const where = chunks.length > 1 ? ` part ${i + 1}/${chunks.length} (${chunk.label})` : "";
    const input = {
      ...common,
      sql: parts[i],
      fileName: `${path.basename(file)}${where}`,
      ...(chunk.context ? { context: chunk.context } : {}),
    };

    const overBudget = budgetReached(`part ${i + 1}/${chunks.length}`);
    if (overBudget) {
      budgetStopped = true;
      const rest = chunks.length > 1 ? `Parts ${i + 1}–${chunks.length}` : "The file";
      warnings.push(`${rest} left unchanged: ${overBudget}.`);
      io.onProgress(`SQL optimize: ${rest.toLowerCase()} left unchanged — ${overBudget}`);
      break;
    }

    let proposal;
    let checks;
    try {
      if (where) io.onProgress(`SQL optimize:${where} — ${parts[i].length.toLocaleString("en-US")} characters`);
      proposal = await proposeSqlSteps(input);
      const total = proposal.steps.length;
      const first = outcomes.length + 1;
      io.onProgress(`SQL optimize: ${total} step(s) proposed${where}`);
      proposal.steps.forEach((step, index) => io.onProgress(`SQL optimize: step ${first + index} proposed — ${step.statement} — ${step.title}`));
      if (total) io.onProgress(`SQL optimize: independent check of ${total} step(s)${where} — do the results stay exactly the same?`);
      checks = total ? await checkSqlSteps(input, proposal.steps) : new Map();
    } catch (error) {
      // Fail-closed per part: without a check nothing of this part is applied; it stays as it was.
      if (!(error instanceof StageError)) throw error;
      failedParts++;
      warnings.push(`Part ${i + 1}/${chunks.length} (${chunk.label}) was left unchanged: ${error.message}`);
      io.onProgress(`SQL optimize:${where || " the file"} left unchanged — ${error.message}`);
      continue;
    }
    dialect = proposal.dialect ?? dialect;
    warnings.push(...proposal.warnings);
    indexSuggestions.push(...proposal.indexSuggestions);

    const offset = outcomes.length;
    const numbered = proposal.steps.map((step, index) => ({
      ...step,
      index: offset + index + 1,
      ...(checks.get(index + 1) ? { check: checks.get(index + 1) } : {}),
    }));
    const rejected = new Map<number, string>();
    for (const step of numbered) {
      const reason = rejectionOf(step, step.check, args.instructions);
      if (reason) rejected.set(step.index, reason);
    }

    // Lines are reported in the output file: count what the earlier (already edited) parts hold.
    const lineOffset = parts.slice(0, i).join("").split("\n").length - 1;
    let partText: string;
    let partOutcomes: StepOutcome[];
    if (verifying && context.probe && testPlan && !("skip" in testPlan)) {
      const verified = await applyStepsVerified({
        original: parts[i],
        steps: numbered,
        rejectedUpFront: rejected,
        probe: context.probe,
        plan: testPlan,
        repeats: 3,
        onProgress: io.onProgress,
        wrap: (part) => [...parts.slice(0, i), part, ...parts.slice(i + 1)].join(""),
        ...(baseline ? { baseline } : {}),
        ...(keptMs !== undefined ? { startMs: keptMs } : {}),
        ...(chunk.context ? { guardContext: chunk.context } : {}),
      });
      ({ text: partText, outcomes: partOutcomes } = verified);
      baseline = verified.baseline;
      baselineMs = verified.baselineMs;
      keptMs = verified.keptMs;
      baselineError = verified.baselineError;
    } else {
      ({ text: partText, outcomes: partOutcomes } = applySteps(parts[i], numbered, rejected, chunk.context ?? ""));
    }
    parts[i] = partText;
    outcomes.push(...partOutcomes.map((step) => (step.lines ? { ...step, lines: step.lines.map((line) => line + lineOffset) } : step)));
  }
  if (failedParts === chunks.length) return { ...base, error: `${warnings.at(-1) ?? "every part failed"} — no file written` };
  if (budgetStopped && !outcomes.length) return { ...base, error: `not optimized — ${warnings.at(-1) ?? "run budget reached"}`, budgetStopped: true };
  const text = parts.join("");

  let verification: string | undefined;
  if (verifying) {
    verification = baselineError
      ? `not compared — the original does not run on the test database: ${baselineError}`
      : `${(testPlan as { describe: string }).describe}, rolled back; ${baselineMs} ms → ${keptMs ?? baselineMs} ms`;
  } else if (context.probe) {
    verification =
      context.probe.dialect === "mysql"
        ? "not compared — MySQL commits CREATE/ALTER at once, so no rolled-back test run"
        : `not compared — ${testPlan && "skip" in testPlan ? testPlan.skip : "no test plan"}`;
  }
  if (verification) io.onProgress(`SQL verify: ${verification}`);
  for (const step of outcomes) {
    io.onProgress(
      step.status === "applied"
        ? `SQL optimize: step ${step.index}/${outcomes.length} applied (line ${step.lines?.join(", ")}) — ${step.title}`
        : `SQL optimize: step ${step.index}/${outcomes.length} NOT applied — ${step.rejectedBecause}`,
    );
  }

  const report = {
    dialect: (dialect ?? "sqlserver") as OptimizeDialect,
    steps: outcomes,
    warnings: [...(verification ? [`Test database: ${verification}.`] : []), ...warnings],
    indexSuggestions: [...new Set(indexSuggestions)],
  };
  io.onProgress(`SQL optimize: 4/4 writing the optimized file`);
  await writeSqlFile(outPath, renderOptimizedFile(report, text, file), source);
  io.onProgress(`SQL optimize: written to ${outPath}`);
  return {
    source: file,
    outputPath: outPath,
    dialect: report.dialect,
    ...(verification ? { verification } : {}),
    ...(budgetStopped ? { budgetStopped: true } : {}),
    ...(planFile ? { plan: executionPlan ? `${path.basename(planFile)} (${executionPlan.format}, ${executionPlan.operators} operator(s))` : `${path.basename(planFile)} (unreadable)` } : {}),
    warnings,
    steps: outcomes.map(({ check, db, ...step }) => ({
      ...step,
      ...(check ? { verdict: check.verdict, verdictReason: check.reason } : {}),
      ...(db ? { db } : {}),
    })),
  };
}

/** The real tables behind the file: from the given schema file and/or the test database's catalog. */
async function schemaFor(sql: string, context: Context, io: CommandIo): Promise<string> {
  const parts: string[] = [];
  if (context.givenSchema.trim()) parts.push(context.givenSchema.trim());
  if (context.probe) {
    const tables = [...logicReferences(sql)]
      .filter((ref) => ref.startsWith("table:"))
      .map((ref) => ref.slice("table:".length))
      .filter((name) => !/^[@#]/.test(name));
    try {
      const described = await context.probe.describeTables(tables);
      if (described) {
        io.onProgress(`SQL verify: schema read from the test database for ${tables.length} table(s)`);
        parts.push(described);
      }
    } catch (error) {
      io.onProgress(`SQL verify: could not read the schema (${error instanceof Error ? error.message : String(error)}) — continuing without it`);
    }
  }
  const schema = parts.join("\n\n");
  return schema.length > MAX_SCHEMA_CHARS ? `${schema.slice(0, MAX_SCHEMA_CHARS)}\n… (schema cut at ${MAX_SCHEMA_CHARS} characters)` : schema;
}

function summaryOf(view: SqlFileView): string {
  if (view.error) return `${path.basename(view.source)}: NOT optimized — ${view.error}`;
  const applied = view.steps.filter((step) => step.status === "applied").length;
  return [
    `${path.basename(view.source)} → ${view.outputPath} (${view.dialect}). The original is unchanged.`,
    `${applied} of ${view.steps.length} step(s) applied; every other line is the original.`,
    ...(view.verification ? [`Test database: ${view.verification}`] : []),
    ...view.steps.map(
      (step) =>
        `- Step ${step.index} [${step.status === "applied" ? `applied, line ${step.lines?.join(", ")}` : "NOT applied"}] ${step.title}` +
        (step.status === "rejected" ? ` — ${step.rejectedBecause}` : "") +
        (step.db ? ` — ${step.db.detail}, ${step.db.msBefore} → ${step.db.msAfter} ms` : ""),
    ),
  ].join("\n");
}

/** A run record the UI's history lists: log.json (summary) and report.md (every step, before/after). */
async function writeRunRecord(
  args: SqlOptimizeArgs,
  views: SqlFileView[],
  status: string,
  message: string,
  started: Date,
): Promise<string> {
  const target = path.resolve(args.file);
  const folder = statSync(target).isFile() ? path.dirname(target) : target;
  const slug = (text: string) => text.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "sql";
  const id = `${started.toISOString().replace(/[:.]/g, "-")}-${slug(path.basename(folder))}-sql-${slug(path.basename(target, ".sql"))}`;
  const dir = path.join(RUNS_DIR(), id);
  await mkdir(dir, { recursive: true });
  const fence = (code: string) => ["```sql", code.trim(), "```"];
  const report = [
    `# SQL optimize — ${path.basename(target)}`,
    "",
    `Status: **${status}** · ${views.length} file(s) · ${started.toISOString()}`,
    ...views.flatMap((view) => [
      "",
      `## ${path.basename(view.source)}`,
      "",
      view.error ? `Not optimized: ${view.error}` : `Output: \`${view.outputPath}\` (${view.dialect})`,
      ...(view.plan ? ["", `Execution plan: ${view.plan}`] : []),
      ...(view.verification ? ["", `Test database: ${view.verification}`] : []),
      ...view.steps.flatMap((step) => [
        "",
        `### Step ${step.index} — ${step.title} — ${step.status === "applied" ? `applied (line ${step.lines?.join(", ")})` : "NOT applied"}`,
        "",
        `- Query: ${step.statement}`,
        ...(step.planEvidence?.trim() ? [`- Plan hotspot addressed: ${step.planEvidence.trim()}`] : []),
        ...(step.rejectedBecause ? [`- Not applied because: ${step.rejectedBecause}`] : []),
        `- Faster because: ${step.why}`,
        `- Same results because: ${step.equivalence}`,
        ...(step.verdict ? [`- Independent check: ${step.verdict} — ${step.verdictReason ?? ""}`] : []),
        ...(step.db ? [`- Test database: ${step.db.detail}; ${step.db.msBefore} → ${step.db.msAfter} ms`] : []),
        ...step.edits.flatMap((edit, position) => [
          "",
          `Before${step.edits.length > 1 ? ` ${position + 1}/${step.edits.length}` : ""}:`,
          ...fence(edit.before),
          "After:",
          ...fence(edit.after),
        ]),
      ]),
      ...((view.warnings ?? []).length ? ["", "**Check before use**", ...(view.warnings ?? []).map((warning) => `- ${warning}`)] : []),
    ]),
  ].join("\n");
  await writeFile(path.join(dir, "report.md"), `${report}\n`, "utf-8");
  await writeFile(
    path.join(dir, "log.json"),
    JSON.stringify(
      {
        mode: "sql",
        startedAt: started.toISOString(),
        finishedAt: new Date().toISOString(),
        finalStatus: status,
        finalMessage: message,
        spec: { projectPath: folder },
        files: views,
      },
      null,
      2,
    ),
    "utf-8",
  );
  return dir;
}

/** The spend so far against `--max-run-usd`, in words, or null while under it (no cap: always null). */
function budgetReached(before: string): string | null {
  try {
    assertRunBudget(before);
    return null;
  } catch (error) {
    if (!(error instanceof RunBudgetError)) throw error;
    return `run budget reached (~$${error.spentUsd.toFixed(2)} of $${error.capUsd.toFixed(2)})`;
  }
}
