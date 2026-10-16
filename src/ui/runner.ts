import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseEventLine, EVENT_STREAM_ENV, type PipelineStepEvent, type SqlFileView } from "../events.js";
import { buildRoots, type RootRole } from "../target-roots.js";
import { OPTIMIZE_DIALECTS, optimizedPathOf, sqlFilesOf } from "../sql-file.js";
import { parseTestCalls } from "../sql-verify.js";
import { killTree } from "../kill-tree.js";
import { addUsage, describeUsage, emptyUsage, subtractUsage, totalTokens, type TokenUsage } from "../token-usage.js";
import { repoRoot } from "./paths.js";
import { buildMindMap, type MindMapNode } from "./mind-map.js";
import {
  isSetbackProgress,
  stageOfProgress,
  stageOfStep,
  taskCountOfProgress,
  type RunMode,
  type StageId,
} from "./stages.js";

/**
 * Owns the one pipeline run the UI can have in flight, and turns its output
 * into state a browser can render.
 *
 * Two deliberate choices:
 *
 * 1. It spawns `bin/aidev.js` rather than importing `runPipeline` in-process.
 *    `src/index.ts` calls `process.chdir(spec.projectPath)`, which is
 *    process-global: in-process runs would move the server's own working
 *    directory under each target project and leave it there. Spawning also
 *    reuses the launcher's `.env` loading, so credentials keep working exactly
 *    as they do from a terminal — one launch path, not two.
 *
 * 2. One run at a time. The pipeline edits a target working tree directly with
 *    no branch isolation (see README), so two concurrent runs against the same
 *    project would interleave edits. `start` refuses instead of queueing,
 *    because the honest answer to "can I run this now" is yes or no, not later.
 */

const MAX_BUFFERED_LINES = 4000;

export type RunStatus =
  | "idle"
  | "running"
  | "done"
  | "escalated-specs"
  | "escalated-e2e"
  | "incomplete"
  | "errored"
  | "progress-kept"
  | "budget-stopped"
  | "needs-answers"
  | "stopped";

export type DbMode = "none" | "connection" | "schema-file";

export interface RunRequest {
  /** "feature" builds from a spec; "clone" ports an existing feature. */
  mode: RunMode;
  /** One project folder holding everything — or leave it out and give BE/FE below. */
  projectPath?: string;
  /** Separate target folders. The same folder in both is treated as one project. */
  projectBePath?: string;
  projectFePath?: string;
  /** Where database scripts go; required when `dbMode` is "connection", since those scripts are what gets run. */
  projectSqlPath?: string;
  /** Clone mode: separate BE/FE source folders in the reference project. */
  referenceBePath?: string;
  referenceFePath?: string;
  /** Feature mode: the spec to build. Spec mode: where the draft is written. */
  specPath?: string;
  /** Spec mode only: the plain-language request to draft a spec from. */
  request?: string;
  /** Spec mode only: replace an existing file at `specPath`. */
  overwrite?: boolean;
  /** Clone mode only: what to port, in the user's words. */
  what?: string;
  /** SQL mode only: the file to optimize. */
  sqlFile?: string;
  /** SQL mode only: "auto" (detected from the code) or one dialect. */
  sqlDialect?: string;
  /** SQL mode only: business-logic changes the person explicitly asks for. Empty: performance only. */
  sqlInstructions?: string;
  /** SQL mode only: a TEST database to read the schema from and run every step on (rolled back). Never leaves this process. */
  sqlVerifyDb?: string;
  /** SQL mode only: calls exercising the file's procedures, one per line. */
  sqlTestCalls?: string;
  /** SQL mode only: a schema/DDL file. */
  sqlSchemaPath?: string;
  /** SQL mode only: an execution plan file, or a folder of plans named like the SQL files. */
  sqlPlanPath?: string;
  dbMode: DbMode;
  /** Only set when dbMode is "connection". Never leaves this process. */
  dbConnection?: string;
  /** Only set when dbMode is "schema-file". */
  dbSchemaPath?: string;
  /** Read-only sample projects: patterns to follow, or the port source. */
  referencePaths?: string[];
  /** Clone mode only: skip the build check. */
  skipBuild?: boolean;
  /** Clone mode only: skip writing and running unit tests. */
  skipTests?: boolean;
  /** Discard progress saved by a stopped run instead of resuming from it. */
  fresh?: boolean;
  /** Ignore the target's `.metadata-standards.yml` for this run, even if present. Default: apply it. */
  noMetadataStandards?: boolean;
  /** Stop before the next agent step once the run has spent this much (USD). Unset: no cap. */
  maxRunUsd?: number;
  /** Feature mode: answers to the business questions the previous run stopped on. */
  answers?: string;
}

export interface RunLine {
  seq: number;
  at: string;
  kind: "progress" | "stdout" | "stderr" | "system";
  text: string;
}

/** Everything about the current run that is safe to send to a browser. */
export interface RunState {
  id: string | null;
  status: RunStatus;
  mode: RunMode;
  startedAt: string | null;
  finishedAt: string | null;
  projectPath: string | null;
  specPath: string | null;
  /** Clone mode: what is being ported. */
  what: string | null;
  dbMode: DbMode;
  stage: StageId | null;
  stageDetail: string | null;
  completedStages: StageId[];
  /** Tokens spent so far, and how much of it each stage spent. */
  usage: TokenUsage;
  stageUsage: Partial<Record<StageId, TokenUsage>>;
  setback: boolean;
  taskCount: number | null;
  finalMessage: string | null;
  logPath: string | null;
  /** Folder name under runs/, so the UI can link straight to the report. */
  logRunId: string | null;
  /** Every step reported so far, by name (`coding:T3`, `gate:T3`, `port:SQL`). */
  steps: Record<string, StepState>;
  /** The tasks / port groups announced before they start, in order. */
  plan: { coding?: { id: string; label: string }[]; port?: { id: string; label: string }[] };
  /** The run's spend cap, when one was set. */
  budgetCapUsd: number | null;
  /** SQL mode: per file, every proposed step and what became of it. */
  sql: { files: SqlFileView[] } | null;
}

/** One pipeline step as the mind map draws it (see `step-activity.ts`). */
export interface StepState {
  stage: StageId;
  status: "active" | "done" | "failed";
  /** Agent turns used and the stage's cap — a budget, not a completion measure. */
  turns?: number;
  maxTurns?: number;
  /** Loop-guard interventions in this step. */
  notes: { repeat: number; blocked: number; softCap: number };
}

export type RunnerEvent = { type: "line"; line: RunLine } | { type: "state"; state: RunState };

/**
 * Rejection reasons carry a stable code, not just prose. The server speaks
 * English (this whole repo does) while the UI speaks Vietnamese, so the code
 * is what crosses the wire and the front end owns the wording. The message
 * stays too, as the fallback for a code the UI hasn't been taught yet.
 */
export type RunRejectionCode =
  | "busy"
  | "busy-other-pipeline"
  | "spec-not-found"
  | "project-not-found"
  | "schema-not-found"
  | "reference-not-found"
  | "reference-required"
  | "what-required"
  | "db-connection-required"
  | "request-required"
  | "spec-path-required"
  | "spec-exists"
  | "sql-folder-required"
  | "sql-file-not-found"
  | "sql-optimized-exists"
  | "plan-not-found";

/** The CLI flag that names each kind of target folder. */
const TARGET_FLAG: Record<RootRole, string> = {
  app: "--project",
  be: "--project-be",
  fe: "--project-fe",
  sql: "--project-sql",
};

export class RunnerBusyError extends Error {
  constructor(
    readonly code: RunRejectionCode = "busy",
    message = "A run is already in progress. Stop it before starting another.",
  ) {
    super(message);
    this.name = "RunnerBusyError";
  }
}

export class RunRequestError extends Error {
  constructor(
    message: string,
    readonly code: RunRejectionCode,
    /** The offending path, so the UI can show it inside its own sentence. */
    readonly detail = "",
  ) {
    super(message);
    this.name = "RunRequestError";
  }
}

export class PipelineRunner {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stopping = false;
  private seq = 0;
  private lines: RunLine[] = [];
  private listeners = new Set<(event: RunnerEvent) => void>();
  private secret: string | null = null;
  private state: RunState;

  /**
   * @param idleMode what the idle state names before this runner's first run —
   *   the UI keeps one runner per tab, so an idle SQL runner reads as "sql".
   */
  constructor(
    private readonly toolRoot: string = repoRoot,
    idleMode: RunMode = "feature",
  ) {
    this.state = idleState(idleMode);
  }

  subscribe(listener: (event: RunnerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): RunState & { mindMap: MindMapNode } {
    const state: RunState = {
      ...this.state,
      completedStages: [...this.state.completedStages],
      stageUsage: { ...this.state.stageUsage },
      steps: Object.fromEntries(
        Object.entries(this.state.steps).map(([name, step]) => [name, { ...step, notes: { ...step.notes } }]),
      ),
      plan: { ...this.state.plan },
    };
    return { ...state, mindMap: buildMindMap(state) };
  }

  getLines(): RunLine[] {
    return [...this.lines];
  }

  isRunning(): boolean {
    return this.child !== null;
  }

  start(request: RunRequest): RunState {
    if (this.child) throw new RunnerBusyError();

    if (request.mode === "sql") return this.startSqlOptimize(request);

    const clone = request.mode === "clone";
    if (!request.projectPath?.trim() && !request.projectBePath?.trim() && !request.projectFePath?.trim()) {
      throw new RunRequestError("Choose the target project folder(s).", "project-not-found");
    }
    const roots = buildRoots({
      project: request.projectPath,
      be: request.projectBePath,
      fe: request.projectFePath,
      sql: request.projectSqlPath,
    });
    for (const root of roots) assertDirectory(root.path, "Project folder", "project-not-found");
    const projectPath = roots[0].path;
    const targetArgs = roots.flatMap((root) => [TARGET_FLAG[root.role], root.path]);

    if (request.mode === "spec") return this.startSpecDraft(request, projectPath, targetArgs);

    const specPath = clone ? null : path.resolve(request.specPath ?? "");
    const what = clone ? (request.what ?? "").trim() : null;

    if (clone) {
      if (!what) throw new RunRequestError("Say what to clone.", "what-required");
    } else {
      assertFile(specPath as string, "Spec file", "spec-not-found");
    }

    const referencePaths = (request.referencePaths ?? [])
      .map((candidate) => candidate.trim())
      .filter(Boolean)
      .map((candidate) => path.resolve(candidate));
    for (const reference of referencePaths) {
      assertDirectory(reference, "Reference repository", "reference-not-found");
    }
    // Clone mode's separate BE/FE source folders. Same folder in both = one.
    const referenceRoots = clone
      ? buildRoots({ be: request.referenceBePath, fe: request.referenceFePath })
      : [];
    for (const root of referenceRoots) {
      assertDirectory(root.path, "Reference repository", "reference-not-found");
    }
    if (clone && !referencePaths.length && !referenceRoots.length) {
      throw new RunRequestError("Clone mode needs a reference repository.", "reference-required");
    }

    // The two pipelines are separate commands, so the argument lists diverge
    // here rather than one growing flags the other ignores.
    const args = clone
      ? ["clone", "--what", what as string, ...targetArgs]
      : ["--spec", specPath as string, ...targetArgs];

    for (const reference of referencePaths) args.push(clone ? "--from" : "--reference", reference);
    for (const root of referenceRoots) {
      args.push(root.role === "be" ? "--from-be" : root.role === "fe" ? "--from-fe" : "--from", root.path);
    }
    if (request.fresh) args.push("--fresh");
    if (request.noMetadataStandards) args.push("--no-metadata-standards");
    if (request.maxRunUsd !== undefined && Number.isFinite(request.maxRunUsd) && request.maxRunUsd > 0) {
      args.push("--max-run-usd", String(request.maxRunUsd));
    }

    if (!clone && request.answers?.trim()) args.push("--answers", request.answers.trim());

    if (clone) {
      if (request.skipBuild) args.push("--no-build");
      if (request.skipTests) args.push("--no-tests");
      this.secret = null;
    } else if (request.dbMode === "connection") {
      const value = request.dbConnection?.trim();
      if (!value) {
        throw new RunRequestError("A database connection string is required.", "db-connection-required");
      }
      // The scripts the run applies are the new ones in this folder; without it there is nothing to apply.
      if (!roots.some((root) => root.role === "sql")) {
        throw new RunRequestError("Running scripts against the database needs a SQL folder.", "sql-folder-required");
      }
      args.push("--db-connection", value);
      this.secret = value;
    } else if (request.dbMode === "schema-file") {
      const schemaPath = path.resolve(request.dbSchemaPath ?? "");
      assertFile(schemaPath, "Schema file", "schema-not-found");
      args.push("--db-schema", schemaPath);
      this.secret = null;
    } else {
      this.secret = null;
    }

    return this.launch(args, {
      mode: request.mode,
      projectPath,
      specPath,
      what,
      dbMode: clone ? "none" : request.dbMode,
    });
  }

  /**
   * `aidev spec`: read-only, writes one new file, and ends there. Confirming
   * the draft and building from it is a separate feature run the person
   * starts — this method never chains into one.
   */
  private startSpecDraft(request: RunRequest, projectPath: string, targetArgs: string[]): RunState {
    const text = (request.request ?? "").trim();
    if (!text) throw new RunRequestError("Describe what the spec should cover.", "request-required");
    if (!request.specPath?.trim()) {
      throw new RunRequestError("Choose where to save the drafted spec.", "spec-path-required");
    }
    const specPath = path.resolve(request.specPath);
    // Asked here, not left to the CLI, so the UI can ask the person before any
    // agent runs instead of after a draft has been paid for.
    if (existsSync(specPath) && !request.overwrite) {
      throw new RunRequestError(`Spec file already exists: ${specPath}`, "spec-exists", specPath);
    }

    const args = ["spec", "--request", text, ...targetArgs, "--out", specPath];
    for (const candidate of request.referencePaths ?? []) {
      if (!candidate.trim()) continue;
      const reference = path.resolve(candidate.trim());
      assertDirectory(reference, "Reference repository", "reference-not-found");
      args.push("--reference", reference);
    }
    if (request.overwrite) args.push("--overwrite");
    this.secret = null;

    return this.launch(args, { mode: "spec", projectPath, specPath, what: null, dbMode: "none" });
  }

  /**
   * `aidev sql-optimize`: reads one SQL file and writes `<name>_optimized.sql`
   * next to it. Needs no project folder; the original is never written.
   */
  private startSqlOptimize(request: RunRequest): RunState {
    const file = path.resolve((request.sqlFile ?? "").trim() || ".");
    let files: string[];
    try {
      if (!request.sqlFile?.trim()) throw new Error("none");
      files = sqlFilesOf(file);
    } catch {
      throw new RunRequestError(`SQL file or folder not found: ${file}`, "sql-file-not-found", file);
    }
    if (!files.length) throw new RunRequestError(`No .sql file in ${file}`, "sql-file-not-found", file);
    const existing = files.map(optimizedPathOf).find((out) => existsSync(out));
    // Asked before any agent runs, so the UI can confirm instead of paying for an answer it then refuses.
    if (existing && !request.overwrite) {
      throw new RunRequestError(`Optimized file already exists: ${existing}`, "sql-optimized-exists", existing);
    }
    const schemaPath = request.sqlSchemaPath?.trim() ? path.resolve(request.sqlSchemaPath.trim()) : null;
    if (schemaPath) assertFile(schemaPath, "Schema file", "schema-not-found");
    const args = ["sql-optimize", "--file", file];
    const dialect = (request.sqlDialect ?? "auto").toLowerCase();
    if (dialect !== "auto" && (OPTIMIZE_DIALECTS as string[]).includes(dialect)) args.push("--dialect", dialect);
    if (request.sqlInstructions?.trim()) args.push("--instructions", request.sqlInstructions.trim());
    if (schemaPath) args.push("--schema", schemaPath);
    const planPath = request.sqlPlanPath?.trim() ? path.resolve(request.sqlPlanPath.trim()) : null;
    if (planPath) {
      if (!existsSync(planPath)) throw new RunRequestError(`Execution plan not found: ${planPath}`, "plan-not-found", planPath);
      args.push("--plan", planPath);
    }
    const verifyDb = request.sqlVerifyDb?.trim();
    if (verifyDb) {
      args.push("--verify-db", verifyDb);
      for (const call of parseTestCalls(request.sqlTestCalls)) args.push("--test-call", call);
    }
    if (request.overwrite) args.push("--overwrite");
    // The connection string can carry a password: masked in every line the UI shows.
    this.secret = verifyDb || null;
    const folder = statSync(file).isFile() ? path.dirname(file) : file;
    return this.launch(args, { mode: "sql", projectPath: folder, specPath: file, what: null, dbMode: verifyDb ? "connection" : "none" });
  }

  private launch(
    args: string[],
    run: Pick<RunState, "mode" | "projectPath" | "specPath" | "what" | "dbMode">,
  ): RunState {
    this.seq = 0;
    this.lines = [];
    this.stopping = false;
    this.state = {
      ...run,
      id: new Date().toISOString(),
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      stage: null,
      stageDetail: null,
      completedStages: [],
      usage: emptyUsage(),
      stageUsage: {},
      setback: false,
      taskCount: null,
      finalMessage: null,
      logPath: null,
      logRunId: null,
      steps: {},
      plan: {},
      budgetCapUsd: null,
      sql: null,
    };

    const launcher = path.join(this.toolRoot, "bin", "aidev.js");
    this.child = spawn(process.execPath, [launcher, ...args], {
      cwd: this.toolRoot,
      env: { ...process.env, [EVENT_STREAM_ENV]: "1" },
      windowsHide: true,
      // A process group on POSIX makes Stop able to reach the pipeline's own
      // children (tsx, the target project's dev server, Playwright). On
      // Windows detaching would pop a console window, so Stop uses taskkill /T
      // there instead.
      detached: process.platform !== "win32",
    });

    this.pushLine("system", `$ node ${launcher} ${args.map(quoteForDisplay).join(" ")}`);
    this.wire(this.child);
    this.emitState();
    return this.getState();
  }

  /** Stops the run and everything it started. No-op when nothing is running. */
  stop(): void {
    if (!this.child?.pid) return;
    this.stopping = true;
    this.pushLine("system", "Stop requested — terminating the pipeline and its child processes.");
    killTree(this.child.pid);
  }

  private wire(child: ChildProcessWithoutNullStreams): void {
    let stdoutRest = "";
    let stderrRest = "";

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");

    child.stdout.on("data", (chunk: string) => {
      stdoutRest = this.consume(stdoutRest + chunk, (line) => this.handleStdoutLine(line));
    });
    child.stderr.on("data", (chunk: string) => {
      stderrRest = this.consume(stderrRest + chunk, (line) => this.pushLine("stderr", line));
    });

    child.on("error", (error) => {
      this.pushLine("stderr", `Failed to start the pipeline: ${error.message}`);
    });

    child.on("close", (code) => {
      if (stdoutRest.trim()) this.handleStdoutLine(stdoutRest);
      if (stderrRest.trim()) this.pushLine("stderr", stderrRest);
      this.finalize(code);
    });
  }

  /** Splits a buffer into whole lines, returning the unterminated remainder. */
  private consume(buffer: string, onLine: (line: string) => void): string {
    const parts = buffer.split(/\r?\n/);
    const rest = parts.pop() ?? "";
    for (const line of parts) onLine(line);
    return rest;
  }

  private handleStdoutLine(line: string): void {
    const event = parseEventLine(line);
    if (!event) {
      if (line.trim()) this.pushLine("stdout", line);
      return;
    }

    switch (event.type) {
      case "progress": {
        this.pushLine("progress", event.message);
        this.applyProgress(event.message);
        break;
      }
      case "finished": {
        this.state.finalMessage = event.message;
        this.state.logPath = event.logPath ?? null;
        this.state.logRunId = event.logPath ? path.basename(event.logPath) : null;
        this.state.status = asRunStatus(event.status);
        if (event.logPath) void this.saveUsage(event.logPath);
        this.emitState();
        break;
      }
      case "usage": {
        this.applyUsage(event.total);
        break;
      }
      case "crashed": {
        this.state.finalMessage = event.message;
        this.state.status = "errored";
        this.emitState();
        break;
      }
      case "step": {
        this.applyStep(event);
        break;
      }
      case "budget": {
        this.state.budgetCapUsd = event.capUsd;
        this.emitState();
        break;
      }
      case "sql-steps": {
        this.state.sql = { files: event.files };
        this.emitState();
        break;
      }
    }
  }

  /**
   * Keeps the mind map's state. A step that starts again (a resumed run
   * replays nothing, but a fix round re-runs a check) is drawn active again
   * with its notes kept.
   */
  private applyStep(event: PipelineStepEvent): void {
    if (event.phase === "plan") {
      this.state.plan[event.group] = event.items;
      this.emitState();
      return;
    }
    const stage = stageOfStep(event.step);
    if (!stage) return;
    const step = (this.state.steps[event.step] ??= {
      stage,
      status: "active",
      notes: { repeat: 0, blocked: 0, softCap: 0 },
    });
    if (event.phase === "start") step.status = "active";
    if (event.phase === "end") step.status = event.ok === false ? "failed" : "done";
    if (event.turns !== undefined) step.turns = event.turns;
    if (event.maxTurns !== undefined) step.maxTurns = event.maxTurns;
    if (event.note === "repeat") step.notes.repeat++;
    if (event.note === "blocked") step.notes.blocked++;
    if (event.note === "soft-cap") step.notes.softCap++;
    this.emitState();
  }

  /**
   * The CLI sends its running total; the increase since the last one belongs
   * to the stage active now — a stage's progress line precedes its agent
   * calls, so they finish while it is current.
   */
  private applyUsage(total: TokenUsage): void {
    const delta = subtractUsage(total, this.state.usage);
    this.state.usage = total;
    const stage = this.state.stage;
    if (stage) this.state.stageUsage[stage] = addUsage(this.state.stageUsage[stage] ?? emptyUsage(), delta);
    this.emitState();
  }

  /**
   * Writes the per-stage figures next to the run's log and appends them to its
   * report, so the history view shows them too. Best-effort: a failed write
   * must not turn a finished run into an errored one.
   */
  private async saveUsage(runDir: string): Promise<void> {
    const { usage, stageUsage } = this.state;
    if (!totalTokens(usage)) return;
    try {
      await writeFile(
        path.join(runDir, "usage.json"),
        JSON.stringify({ total: usage, stages: stageUsage }, null, 2),
        "utf-8",
      );
      const lines = ["", "## Token usage", "", `- **Total:** ${describeUsage(usage)}`];
      for (const [stage, spent] of Object.entries(stageUsage)) {
        if (spent) lines.push(`- ${stage}: ${describeUsage(spent)}`);
      }
      await appendFile(path.join(runDir, "report.md"), `${lines.join("\n")}\n`, "utf-8");
    } catch {
      // See doc comment.
    }
  }

  private applyProgress(message: string): void {
    const stage = stageOfProgress(message);
    if (stage && stage !== this.state.stage) {
      if (this.state.stage && !this.state.completedStages.includes(this.state.stage)) {
        this.state.completedStages.push(this.state.stage);
      }
      this.state.stage = stage;
    }
    this.state.stageDetail = message;
    this.state.setback = isSetbackProgress(message);
    const tasks = taskCountOfProgress(message);
    if (tasks !== null) this.state.taskCount = tasks;
    this.emitState();
  }

  private finalize(code: number | null): void {
    this.child = null;
    this.state.finishedAt = new Date().toISOString();

    if (this.stopping) {
      this.state.status = "stopped";
      this.state.finalMessage =
        "Run stopped from the UI. Files already written to the target project were not reverted.";
    } else if (this.state.status === "running") {
      // No terminal event arrived: the process died before reporting a verdict.
      this.state.status = "errored";
      this.state.finalMessage = `The pipeline exited with code ${code ?? "unknown"} without reporting a result. See the output above.`;
    }

    if (this.state.stage && !this.state.completedStages.includes(this.state.stage)) {
      this.state.completedStages.push(this.state.stage);
    }
    // A step still active when the process ended did not finish.
    for (const step of Object.values(this.state.steps)) {
      if (step.status === "active") step.status = "failed";
    }

    this.stopping = false;
    this.secret = null;
    this.pushLine("system", `Pipeline exited (code ${code ?? "unknown"}) — status: ${this.state.status}`);
    this.emitState();
  }

  private pushLine(kind: RunLine["kind"], text: string): void {
    const line: RunLine = {
      seq: ++this.seq,
      at: new Date().toISOString(),
      kind,
      text: this.redact(text.replace(/\s+$/, "")),
    };
    this.lines.push(line);
    if (this.lines.length > MAX_BUFFERED_LINES) this.lines.shift();
    this.emit({ type: "line", line });
  }

  /**
   * A `--db-connection` value can carry a real password. Nothing in the
   * pipeline echoes it today, but the target project's own tooling might
   * (a failed connection error, a debug log), and this output goes to a
   * browser and stays in a buffer. Mask it on the way out.
   */
  private redact(text: string): string {
    if (!this.secret) return text;
    return text.split(this.secret).join("***");
  }

  private emitState(): void {
    this.emit({ type: "state", state: this.getState() });
  }

  private emit(event: RunnerEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function idleState(mode: RunMode = "feature"): RunState {
  return {
    id: null,
    status: "idle",
    mode,
    startedAt: null,
    finishedAt: null,
    projectPath: null,
    specPath: null,
    what: null,
    dbMode: "none",
    stage: null,
    stageDetail: null,
    completedStages: [],
    usage: emptyUsage(),
    stageUsage: {},
    setback: false,
    taskCount: null,
    finalMessage: null,
    logPath: null,
    logRunId: null,
    steps: {},
    plan: {},
    budgetCapUsd: null,
    sql: null,
  };
}

function asRunStatus(status: string): RunStatus {
  const known: RunStatus[] = [
    "done",
    "escalated-specs",
    "escalated-e2e",
    "incomplete",
    "errored",
    "progress-kept",
    "budget-stopped",
    "needs-answers",
  ];
  return known.includes(status as RunStatus) ? (status as RunStatus) : "errored";
}

function assertFile(candidate: string, label: string, code: RunRejectionCode): void {
  if (!existsSync(candidate) || !statSync(candidate).isFile()) {
    throw new RunRequestError(`${label} not found: ${candidate}`, code, candidate);
  }
}

function assertDirectory(candidate: string, label: string, code: RunRejectionCode): void {
  if (!existsSync(candidate) || !statSync(candidate).isDirectory()) {
    throw new RunRequestError(`${label} not found: ${candidate}`, code, candidate);
  }
}

function quoteForDisplay(arg: string): string {
  return /\s/.test(arg) ? `"${arg}"` : arg;
}
