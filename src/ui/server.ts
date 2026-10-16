import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { config, modelsInUse } from "../config.js";
import { browse, BrowseError, type BrowseKind } from "./browse.js";
import { refusalOf } from "./request-guard.js";
import { deletePreset, listPresets, savePreset } from "./presets.js";
import { publicDir, repoRoot, specsDir } from "./paths.js";
import {
  PipelineRunner,
  RunnerBusyError,
  RunRequestError,
  type DbMode,
  type RunnerEvent,
} from "./runner.js";
import { clearRuns, deleteRun, evidenceFile, listRuns, readRun, RunNotFoundError } from "./runs.js";
import { STAGE_IDS_BY_MODE, type RunMode } from "./stages.js";

/**
 * The local web UI for the pipeline: a browser front end over the same
 * `aidev` command, so a run is a form and a live log instead of a terminal
 * invocation with two absolute paths in it.
 *
 * Bound to 127.0.0.1 and only to 127.0.0.1. Every endpoint here can read any
 * path on this machine and start an agent that edits any project on it —
 * that is the tool's job, but it means the server must never be reachable
 * from the network. There is no auth layer because there is no remote caller
 * to authenticate; if that assumption ever changes, this is the line that has
 * to change first.
 */

const HOST = "127.0.0.1";
const DEFAULT_PORT = 4319;
const MAX_BODY_BYTES = 2_000_000; // A spec is prose; 2MB is far past any real one.

/**
 * One runner per tab, each with its own state, log and Stop: the "task mới"
 * tab (feature runs and spec drafts), the clone tab and the SQL tab. A SQL
 * optimization only reads its file and writes <name>_optimized.sql, so it runs
 * alongside anything. The two pipelines write into project folders, so only
 * one of them runs at a time (`startRun`).
 */
type Channel = "feature" | "clone" | "sql";
const CHANNELS: Channel[] = ["feature", "clone", "sql"];
const runners: Record<Channel, PipelineRunner> = {
  feature: new PipelineRunner(undefined, "feature"),
  clone: new PipelineRunner(undefined, "clone"),
  sql: new PipelineRunner(undefined, "sql"),
};
const channelOf = (mode: RunMode): Channel => (mode === "sql" ? "sql" : mode === "clone" ? "clone" : "feature");
const asChannel = (value: unknown): Channel => (CHANNELS.includes(value as Channel) ? (value as Channel) : "feature");
/** The other pipeline that writes into project folders, if this channel has one. */
const rivalOf = (channel: Channel): Channel | null => (channel === "feature" ? "clone" : channel === "clone" ? "feature" : null);

interface Options {
  port: number;
  open: boolean;
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    port: Number(process.env.AIDEV_UI_PORT ?? DEFAULT_PORT),
    open: true,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port") options.port = Number(argv[++i]);
    else if (argv[i] === "--no-open") options.open = false;
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error(`Invalid port: ${options.port}`);
  }
  return options;
}

const server = createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error("UI request failed:", error);
    if (!res.headersSent) sendJson(res, 500, { error: "Internal error. See the server console." });
    else res.end();
  });
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const refused = refusalOf(req, options.port);
  if (refused) return sendJson(res, 403, { error: `Refused: ${refused}.` });
  const url = new URL(req.url ?? "/", `http://${HOST}`);
  const route = `${req.method} ${url.pathname}`;

  if (req.method === "GET" && url.pathname.startsWith("/evidence/")) return sendEvidence(res, url.pathname);

  switch (route) {
    case "GET /":
      return sendStatic(res, "index.html");
    case "GET /app.js":
      return sendStatic(res, "app.js");
    case "GET /mindmap.js":
      return sendStatic(res, "mindmap.js");
    case "GET /styles.css":
      return sendStatic(res, "styles.css");

    case "GET /api/config":
      return sendJson(res, 200, {
        repoRoot,
        specsDir,
        platform: process.platform,
        // Model ids, strong tier first (one id when CLAUDE_MODEL puts every stage on one model).
        models: modelsInUse(),
        // Booleans only: whether a credential exists is useful to show, the
        // value itself must never leave this process.
        credentials: {
          apiKey: Boolean(process.env.ANTHROPIC_API_KEY),
          oauthToken: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN),
        },
        // Ids only — the front end owns what a stage is called on screen.
        stages: STAGE_IDS_BY_MODE,
      });

    case "GET /api/state":
      return sendJson(res, 200, {
        channels: Object.fromEntries(CHANNELS.map((channel) => [channel, { state: runners[channel].getState(), lines: runners[channel].getLines() }])),
      });

    case "GET /api/stream":
      return streamEvents(req, res);

    case "POST /api/run":
      return startRun(req, res);

    case "POST /api/stop": {
      const channel = asChannel((await readJsonBody(req)).channel);
      runners[channel].stop();
      return sendJson(res, 200, { channel, state: runners[channel].getState() });
    }

    case "GET /api/browse":
      return browsePath(res, url);

    case "GET /api/runs":
      return sendJson(res, 200, { runs: await listRuns() });

    case "GET /api/run-detail":
      return runDetail(res, url);

    case "POST /api/runs/delete":
      return removeRun(req, res);

    case "POST /api/runs/clear":
      return clearAllRuns(res);

    case "GET /api/presets":
      return sendJson(res, 200, { presets: await listPresets() });

    case "POST /api/presets":
      return upsertPreset(req, res);

    case "POST /api/presets/delete":
      return removePreset(req, res);

    default:
      return sendJson(res, 404, { error: `No route for ${route}` });
  }
}

// --- Route handlers -------------------------------------------------------

async function startRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const dbMode = (body.dbMode as DbMode) ?? "none";
  const mode = (body.mode as RunMode) ?? "feature";
  if (!["none", "connection", "schema-file"].includes(dbMode)) {
    return sendJson(res, 400, { error: `Unknown dbMode: ${String(body.dbMode)}` });
  }
  if (!["feature", "clone", "spec", "sql"].includes(mode)) {
    return sendJson(res, 400, { error: `Unknown mode: ${String(body.mode)}` });
  }

  const channel = channelOf(mode);
  const rival = rivalOf(channel);
  if (rival && runners[rival].isRunning()) {
    const message = `A ${rival} run is writing into project folders; wait for it or stop it first.`;
    return sendJson(res, 409, { error: message, code: "busy-other-pipeline", detail: rival });
  }

  try {
    const state = runners[channel].start({
      mode,
      specPath: String(body.specPath ?? ""),
      what: String(body.what ?? ""),
      ...(typeof body.sqlFile === "string" ? { sqlFile: body.sqlFile } : {}),
      ...(typeof body.sqlDialect === "string" ? { sqlDialect: body.sqlDialect } : {}),
      ...(typeof body.sqlInstructions === "string" ? { sqlInstructions: body.sqlInstructions } : {}),
      ...(typeof body.sqlVerifyDb === "string" ? { sqlVerifyDb: body.sqlVerifyDb } : {}),
      ...(typeof body.sqlTestCalls === "string" ? { sqlTestCalls: body.sqlTestCalls } : {}),
      ...(typeof body.sqlSchemaPath === "string" ? { sqlSchemaPath: body.sqlSchemaPath } : {}),
      ...(typeof body.sqlPlanPath === "string" ? { sqlPlanPath: body.sqlPlanPath } : {}),
      request: String(body.request ?? ""),
      overwrite: body.overwrite === true,
      skipBuild: body.skipBuild === true,
      skipTests: body.skipTests === true,
      fresh: body.fresh === true,
      noMetadataStandards: body.noMetadataStandards === true,
      ...(typeof body.answers === "string" && body.answers.trim() ? { answers: body.answers } : {}),
      ...(typeof body.maxRunUsd === "number" && Number.isFinite(body.maxRunUsd) && body.maxRunUsd > 0
        ? { maxRunUsd: body.maxRunUsd }
        : {}),
      projectPath: optionalString(body.projectPath),
      projectBePath: optionalString(body.projectBePath),
      projectFePath: optionalString(body.projectFePath),
      projectSqlPath: optionalString(body.projectSqlPath),
      referenceBePath: optionalString(body.referenceBePath),
      referenceFePath: optionalString(body.referenceFePath),
      dbMode,
      dbConnection: typeof body.dbConnection === "string" ? body.dbConnection : undefined,
      dbSchemaPath: typeof body.dbSchemaPath === "string" ? body.dbSchemaPath : undefined,
      referencePaths: Array.isArray(body.referencePaths)
        ? body.referencePaths.filter((entry): entry is string => typeof entry === "string")
        : [],
    });
    sendJson(res, 200, { channel, state });
  } catch (error) {
    // `code` is what the UI renders from; `error` is the English fallback.
    if (error instanceof RunnerBusyError) {
      return sendJson(res, 409, { error: error.message, code: error.code });
    }
    if (error instanceof RunRequestError) {
      return sendJson(res, 400, { error: error.message, code: error.code, detail: error.detail });
    }
    throw error;
  }
}

function streamEvents(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    // Without this an intermediary (or Node's own buffering) can hold lines
    // back and the "live" log arrives in bursts at the end.
    "X-Accel-Buffering": "no",
  });

  const send = (channel: Channel, event: RunnerEvent): void => {
    res.write(`data: ${JSON.stringify({ ...event, channel })}\n\n`);
  };

  // A browser that connects mid-run must not see an empty console: replay
  // every tab's buffer first, then follow them all.
  for (const channel of CHANNELS) {
    send(channel, { type: "state", state: runners[channel].getState() });
    for (const line of runners[channel].getLines()) send(channel, { type: "line", line });
  }
  const unsubscribers = CHANNELS.map((channel) => runners[channel].subscribe((event) => send(channel, event)));
  const unsubscribe = () => unsubscribers.forEach((stop) => stop());
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

async function browsePath(res: ServerResponse, url: URL): Promise<void> {
  const kind = (url.searchParams.get("kind") ?? "any") as BrowseKind;
  try {
    sendJson(res, 200, await browse(url.searchParams.get("path") ?? "", kind));
  } catch (error) {
    if (error instanceof BrowseError) return sendJson(res, 400, { error: error.message });
    throw error;
  }
}

async function runDetail(res: ServerResponse, url: URL): Promise<void> {
  try {
    sendJson(res, 200, { run: await readRun(url.searchParams.get("id") ?? "") });
  } catch (error) {
    if (error instanceof RunNotFoundError) return sendJson(res, 404, { error: error.message });
    throw error;
  }
}

async function removeRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  try {
    await deleteRun(String(body.id ?? ""));
    sendJson(res, 200, { runs: await listRuns() });
  } catch (error) {
    if (error instanceof RunNotFoundError) return sendJson(res, 404, { error: error.message });
    throw error;
  }
}

async function clearAllRuns(res: ServerResponse): Promise<void> {
  const deleted = await clearRuns();
  sendJson(res, 200, { deleted, runs: await listRuns() });
}

async function upsertPreset(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const name = String(body.name ?? "").trim();
  if (!name) return sendJson(res, 400, { error: "A preset needs a name." });

  const presets = await savePreset({
    name,
    mode: body.mode === "clone" ? "clone" : "feature",
    projectPath: String(body.projectPath ?? ""),
    projectBe: String(body.projectBe ?? ""),
    projectFe: String(body.projectFe ?? ""),
    projectSql: String(body.projectSql ?? ""),
    specDir: String(body.specDir ?? ""),
    specPath: String(body.specPath ?? ""),
    dbMode: (body.dbMode as DbMode) ?? "none",
    dbSchemaPath: String(body.dbSchemaPath ?? ""),
    referencePath: String(body.referencePath ?? ""),
    what: String(body.what ?? ""),
    cloneFromBe: String(body.cloneFromBe ?? ""),
    cloneFromFe: String(body.cloneFromFe ?? ""),
  });
  sendJson(res, 200, { presets });
}

async function removePreset(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  sendJson(res, 200, { presets: await deletePreset(String(body.id ?? "")) });
}

// --- Plumbing -------------------------------------------------------------

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  // What a Playwright HTML report and its trace viewer load.
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webm": "video/webm",
  ".zip": "application/zip",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * `/evidence/<run id>/<path>` — a file of that run's E2E evidence, so the
 * Playwright HTML report (and the traces and videos it links to) opens from
 * the history view. `evidenceFile` keeps the path inside the evidence folder.
 */
async function sendEvidence(res: ServerResponse, pathname: string): Promise<void> {
  const [id = "", ...rest] = pathname.slice("/evidence/".length).split("/").map((part) => decodeURIComponent(part));
  const file = evidenceFile(id, rest.join("/"));
  if (!file) return sendJson(res, 404, { error: "Not found." });
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type": CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: "Not found." });
  }
}

async function sendStatic(res: ServerResponse, name: string): Promise<void> {
  // `name` is a literal from the route table above, never request-derived —
  // there is no path to traverse out of publicDir here.
  const file = path.join(publicDir, name);
  const body = await readFile(file);
  res.writeHead(200, {
    "Content-Type": CONTENT_TYPES[path.extname(name)] ?? "application/octet-stream",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function openBrowser(target: string): void {
  const [command, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", target]]
      : process.platform === "darwin"
        ? ["open", [target]]
        : ["xdg-open", [target]];
  // Best effort: a headless or unusual desktop just means the user clicks the
  // printed URL themselves, which is not a failure worth crashing the server.
  spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true }).on("error", () => {});
}

const options = parseOptions(process.argv.slice(2));

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `aidev ui: port ${options.port} is already in use — the UI may already be running at http://${HOST}:${options.port}, or pick another port with --port.`,
    );
    process.exit(1);
  }
  throw error;
});

server.listen(options.port, HOST, () => {
  const url = `http://${HOST}:${options.port}`;
  console.log(`aidev ui listening on ${url}`);
  console.log(`Tool root: ${repoRoot}`);
  if (options.open) openBrowser(url);
});

// A run outlives no server: the pipeline writes directly into a project
// working tree, and leaving an orphan doing that with nothing watching it is
// worse than stopping it.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    for (const channel of CHANNELS) runners[channel].stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
