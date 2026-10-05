import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { config } from "../config.js";
import { browse, BrowseError, type BrowseKind } from "./browse.js";
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

const runner = new PipelineRunner();

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
  const url = new URL(req.url ?? "/", `http://${HOST}`);
  const route = `${req.method} ${url.pathname}`;

  if (req.method === "GET" && url.pathname.startsWith("/evidence/")) return sendEvidence(res, url.pathname);

  switch (route) {
    case "GET /":
      return sendStatic(res, "index.html");
    case "GET /app.js":
      return sendStatic(res, "app.js");
    case "GET /styles.css":
      return sendStatic(res, "styles.css");

    case "GET /api/config":
      return sendJson(res, 200, {
        repoRoot,
        specsDir,
        platform: process.platform,
        model: config.model,
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
      return sendJson(res, 200, { state: runner.getState(), lines: runner.getLines() });

    case "GET /api/stream":
      return streamEvents(req, res);

    case "POST /api/run":
      return startRun(req, res);

    case "POST /api/stop":
      runner.stop();
      return sendJson(res, 200, { state: runner.getState() });

    case "GET /api/browse":
      return browsePath(res, url);

    case "GET /api/spec":
      return readSpec(res, url);

    case "POST /api/spec":
      return writeSpec(req, res);

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
  if (!["feature", "clone", "spec"].includes(mode)) {
    return sendJson(res, 400, { error: `Unknown mode: ${String(body.mode)}` });
  }

  try {
    const state = runner.start({
      mode,
      specPath: String(body.specPath ?? ""),
      what: String(body.what ?? ""),
      request: String(body.request ?? ""),
      overwrite: body.overwrite === true,
      skipBuild: body.skipBuild === true,
      skipTests: body.skipTests === true,
      fresh: body.fresh === true,
      noMetadataStandards: body.noMetadataStandards === true,
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
    sendJson(res, 200, { state });
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

  const send = (event: RunnerEvent): void => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // A browser that connects mid-run must not see an empty console: replay the
  // buffer first, then follow.
  send({ type: "state", state: runner.getState() });
  for (const line of runner.getLines()) send({ type: "line", line });

  const unsubscribe = runner.subscribe(send);
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

async function readSpec(res: ServerResponse, url: URL): Promise<void> {
  const target = url.searchParams.get("path") ?? "";
  if (!target.trim()) return sendJson(res, 400, { error: "No path given." });
  try {
    const resolved = path.resolve(target);
    sendJson(res, 200, { path: resolved, content: await readFile(resolved, "utf-8") });
  } catch (error) {
    sendJson(res, 400, { error: `Cannot read ${target}: ${describe(error)}` });
  }
}

async function writeSpec(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const target = String(body.path ?? "").trim();
  const content = String(body.content ?? "");
  if (!target) return sendJson(res, 400, { error: "No path given." });

  try {
    const resolved = path.resolve(target);
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, content, "utf-8");
    sendJson(res, 200, { path: resolved });
  } catch (error) {
    sendJson(res, 400, { error: `Cannot write ${target}: ${describe(error)}` });
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
    runner.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
