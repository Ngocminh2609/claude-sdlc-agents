import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseEventLine, EVENT_STREAM_ENV } from "../events.js";
import { buildRoots } from "../target-roots.js";
import { addUsage, describeUsage, emptyUsage, subtractUsage, totalTokens, type TokenUsage } from "../token-usage.js";
import { repoRoot } from "./paths.js";
import {
  isSetbackProgress,
  stageOfProgress,
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
  /** Clone mode: separate BE/FE source folders in the reference project. */
  referenceBePath?: string;
  referenceFePath?: string;
  /** Feature mode only. */
  specPath?: string;
  /** Clone mode only: what to port, in the user's words. */
  what?: string;
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
  | "spec-not-found"
  | "project-not-found"
  | "schema-not-found"
  | "reference-not-found"
  | "reference-required"
  | "what-required"
  | "db-connection-required";

export class RunnerBusyError extends Error {
  readonly code: RunRejectionCode = "busy";

  constructor() {
    super("A run is already in progress. Stop it before starting another.");
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
  private state: RunState = idleState();

  constructor(private readonly toolRoot: string = repoRoot) {}

  subscribe(listener: (event: RunnerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): RunState {
    return {
      ...this.state,
      completedStages: [...this.state.completedStages],
      stageUsage: { ...this.state.stageUsage },
    };
  }

  getLines(): RunLine[] {
    return [...this.lines];
  }

  isRunning(): boolean {
    return this.child !== null;
  }

  start(request: RunRequest): RunState {
    if (this.child) throw new RunnerBusyError();

    const clone = request.mode === "clone";
    const roots = buildRoots({
      project: request.projectPath,
      be: request.projectBePath,
      fe: request.projectFePath,
    });
    if (!roots.length) throw new RunRequestError("Choose the target project folder(s).", "project-not-found");
    for (const root of roots) assertDirectory(root.path, "Project folder", "project-not-found");
    const projectPath = roots[0].path;
    const targetArgs =
      roots.length === 1 && roots[0].role === "app"
        ? ["--project", projectPath]
        : roots.flatMap((root) => [root.role === "fe" ? "--project-fe" : "--project-be", root.path]);

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

    if (clone) {
      if (request.skipBuild) args.push("--no-build");
      if (request.skipTests) args.push("--no-tests");
      this.secret = null;
    } else if (request.dbMode === "connection") {
      const value = request.dbConnection?.trim();
      if (!value) {
        throw new RunRequestError("A database connection string is required.", "db-connection-required");
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

    this.seq = 0;
    this.lines = [];
    this.stopping = false;
    this.state = {
      id: new Date().toISOString(),
      status: "running",
      mode: request.mode,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      projectPath,
      specPath,
      what,
      dbMode: clone ? "none" : request.dbMode,
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
    }
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

function idleState(): RunState {
  return {
    id: null,
    status: "idle",
    mode: "feature",
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
  };
}

function asRunStatus(status: string): RunStatus {
  const known: RunStatus[] = [
    "done",
    "escalated-specs",
    "escalated-e2e",
    "incomplete",
    "errored",
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

/**
 * Kills the pipeline and everything it spawned. `child.kill()` alone would
 * leave the grandchildren (tsx, a dev server started by the E2E stage,
 * Playwright's browsers) running and holding ports.
 */
function killTree(pid: number): void {
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone — nothing to stop.
    }
  }
}
