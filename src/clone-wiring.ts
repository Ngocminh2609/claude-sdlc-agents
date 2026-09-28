import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { rootPath, type ProjectRoot } from "./target-roots.js";
import type { CloneMapping, CloneWiring, UnmatchedApiCall, UnresolvedImport } from "./types.js";

/**
 * Checks that the ported client and server are actually connected, by reading
 * the files rather than asking a model.
 *
 * Coverage proves a file exists; it says nothing about whether the page that
 * was ported can reach anything. A real clone shipped pages importing API
 * client modules that were never written ("to be generated later"), and the
 * run had no stage that noticed: the build check was switched off, and the
 * target's own build already failed on unrelated files, so its verdict could
 * not single the new breakage out. Two questions have mechanical answers and
 * are answered here:
 *
 * 1. Does every local import in a ported client file resolve to a file on
 *    disk? (relative paths and the `@/` → `src/` alias; packages are skipped —
 *    they resolve through node_modules, which is the package manager's job.)
 * 2. Is every API path the ported client calls mapped by some controller in
 *    the server folder? (Spring `@*Mapping`, NestJS decorators, Express
 *    routers; path params match any segment, and a client-side prefix such as
 *    a gateway path is allowed in front of the server path.)
 *
 * What it does not prove: that a request body has the right fields, or that
 * the endpoint behaves. It is deliberately lenient on matching — a false
 * "not wired" on a correct port is worse than missing an exotic route — so a
 * pass is necessary, not sufficient.
 */

const CLIENT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue"];
const RESOLVE_SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".d.ts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".vue",
  ".json",
  "/index.ts",
  "/index.tsx",
  "/index.js",
  "/index.jsx",
];
const SKIP_DIRS = new Set(["node_modules", ".git", "target", "build", "dist", "out", ".idea", ".umi", ".umi-production", "coverage"]);
const MAX_SERVER_FILES = 20000;

export function checkWiring(mapping: CloneMapping, roots: ProjectRoot[]): CloneWiring {
  const clientFolders = roots.filter((root) => root.role !== "be");
  const serverFolders = roots.filter((root) => root.role !== "fe");

  // A set: two mapping entries may land in the same file (several sources
  // merged into one page), and each file is checked once.
  const ported = [
    ...new Set(
      mapping.entries
        .filter((entry) => clientFolders.some((root) => root.path === rootPath(roots, entry.root)))
        .map((entry) => path.resolve(rootPath(roots, entry.root), entry.target))
        .filter((file) => CLIENT_EXTENSIONS.includes(path.extname(file)) && isFile(file)),
    ),
  ];

  const unresolvedImports: UnresolvedImport[] = [];
  const scanForCalls = new Set<string>(ported);

  for (const file of ported) {
    const source = readFileSync(file, "utf-8");
    for (const specifier of localImports(source)) {
      const resolved = resolveImport(file, specifier);
      if (resolved === undefined) continue; // Not a local import.
      if (resolved === null) {
        unresolvedImports.push({ file: displayPath(file, roots), specifier });
      } else if (CLIENT_EXTENSIONS.includes(path.extname(resolved)) && !resolved.endsWith(".d.ts")) {
        // One level out: the API client module a page imports is where its
        // calls are, and it may be a file the port wrote or one already there.
        scanForCalls.add(resolved);
      }
    }
  }

  const endpoints = serverFolders.flatMap((root) => serverEndpoints(root.path));
  const unmatchedCalls: UnmatchedApiCall[] = [];
  let callsChecked = 0;

  if (endpoints.length) {
    for (const file of scanForCalls) {
      for (const call of apiCalls(readFileSync(file, "utf-8"))) {
        callsChecked++;
        if (!endpoints.some((endpoint) => matches(call, endpoint))) {
          unmatchedCalls.push({ file: displayPath(file, roots), method: call.method, url: call.url });
        }
      }
    }
  }

  return { unresolvedImports, unmatchedCalls, callsChecked, endpointsKnown: endpoints.length };
}

export function wiringIsSound(wiring: CloneWiring): boolean {
  return wiring.unresolvedImports.length === 0 && wiring.unmatchedCalls.length === 0;
}

/** One line for the progress stream. */
export function describeWiring(wiring: CloneWiring): string {
  const imports = wiring.unresolvedImports.length;
  const calls = wiring.unmatchedCalls.length;
  const callPart = !wiring.endpointsKnown
    ? "API calls not checked (no server controllers found)"
    : wiring.callsChecked
      ? `${wiring.callsChecked - calls}/${wiring.callsChecked} API call(s) reach a server endpoint`
      : "no API calls found in the ported client files";
  return `${imports ? `${imports} import(s) resolve to nothing` : "all imports resolve"}; ${callPart}`;
}

// --- Imports -------------------------------------------------------------

function localImports(source: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.add(match[1]);
  }
  return [...found];
}

/** The file an import resolves to, null if it resolves to nothing, undefined if it is not local. */
function resolveImport(fromFile: string, specifier: string): string | null | undefined {
  let base: string;
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    base = path.resolve(path.dirname(fromFile), specifier);
  } else if (specifier.startsWith("@/")) {
    const src = srcFolderOf(fromFile);
    if (!src) return undefined;
    base = path.join(src, specifier.slice(2));
  } else {
    return undefined;
  }
  const clean = base.replace(/[?#].*$/, "");
  for (const suffix of RESOLVE_SUFFIXES) {
    if (isFile(clean + suffix)) return clean + suffix;
  }
  return null;
}

/** The `src` folder the `@/` alias points at (Umi, Vite and CRA templates alike). */
function srcFolderOf(file: string): string | null {
  let dir = path.dirname(file);
  while (true) {
    if (path.basename(dir) === "src") return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// --- Client API calls ----------------------------------------------------

interface ApiCall {
  method: string | null;
  url: string;
  segments: string[];
}

function apiCalls(source: string): ApiCall[] {
  const calls: ApiCall[] = [];
  const pattern =
    /\b(?:request|fetch|axios|http|api|client|instance|httpClient)(?:\.(get|post|put|delete|patch))?\s*(?:<[^()]*?>)?\s*\(\s*(`[^`]*`|'[^']*'|"[^"]*")/g;
  for (const match of source.matchAll(pattern)) {
    const url = match[2].slice(1, -1);
    const segments = urlSegments(url);
    if (!segments) continue;
    const after = source.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 400);
    const method = match[1] ?? after.match(/\bmethod\s*:\s*['"`](\w+)['"`]/i)?.[1] ?? null;
    calls.push({ method: method ? method.toUpperCase() : null, url, segments });
  }
  return calls;
}

/**
 * Path segments of a client URL, with interpolations as `{}`. Leading
 * interpolations (`${apiPrefix}`, `${BASE_URL}`) are dropped — the server path
 * is matched as a suffix anyway. Null when there is no static path to check.
 */
function urlSegments(raw: string): string[] | null {
  let url = raw.replace(/\$\{[^}]*\}/g, "{}").replace(/[?#].*$/, "");
  url = url.replace(/^https?:\/\/[^/]+/, "");
  if (!url.includes("/")) return null;
  const segments = url.split("/").filter(Boolean);
  while (segments[0] === "{}") segments.shift();
  if (!segments.length || segments.every((segment) => segment === "{}")) return null;
  return segments;
}

// --- Server endpoints ----------------------------------------------------

/** One route a server file maps, as read from its source. */
export interface ServerEndpoint {
  method: string | null;
  /** The route as written, e.g. "/stats-indicator/{id}". */
  path: string;
  segments: string[];
  /** The handler function / method name, when it could be read. */
  handler?: string;
  /** The controller class and its OpenAPI @Tag, when present. */
  controller?: string;
  tag?: string;
  file: string;
}

type Endpoint = ServerEndpoint;

/**
 * The API the ported server code exposes, read from the server files the
 * mapping put on disk. Handed to the client port groups, so the client is
 * written against the routes that actually exist rather than the reference
 * project's, or a guess.
 */
export function portedServerApi(mapping: CloneMapping, roots: ProjectRoot[]): ServerEndpoint[] {
  const serverFolders = roots.filter((root) => root.role !== "fe");
  const files = new Set(
    mapping.entries
      .filter((entry) => serverFolders.some((root) => root.path === rootPath(roots, entry.root)))
      .map((entry) => path.resolve(rootPath(roots, entry.root), entry.target))
      .filter((file) => isFile(file)),
  );
  return [...files].flatMap((file) => endpointsOfFile(file));
}

/** Lines for a prompt: "GET /stats-indicator/search -> StatsIndicatorController.search [@Tag ...] (file)". */
export function describeServerApi(endpoints: ServerEndpoint[]): string[] {
  return endpoints.map((endpoint) => {
    const handler = endpoint.controller
      ? `${endpoint.controller}${endpoint.handler ? `.${endpoint.handler}` : ""}`
      : (endpoint.handler ?? "");
    const tag = endpoint.tag ? ` [@Tag "${endpoint.tag}"]` : "";
    return `- ${endpoint.method ?? "ANY"} ${endpoint.path}${handler ? ` -> ${handler}` : ""}${tag} (${endpoint.file})`;
  });
}

/** "GET /x/{}"-style routes a source file maps — for the project index. */
export function routesInSource(source: string, file: string): string[] {
  const ext = path.extname(file);
  const endpoints =
    ext === ".java" || ext === ".kt" ? springEndpoints(source, file) : ext === ".ts" || ext === ".js" ? nodeEndpoints(source, file) : [];
  return endpoints.map((endpoint) => `${endpoint.method ?? "ANY"} ${endpoint.path}`);
}

/** The API URLs a client source file calls — for the project index. */
export function clientCallsInSource(source: string): string[] {
  return apiCalls(source).map((call) => `${call.method ?? "?"} ${call.url}`);
}

function serverEndpoints(folder: string): Endpoint[] {
  const endpoints: Endpoint[] = [];
  for (const file of walk(folder)) endpoints.push(...endpointsOfFile(file));
  return endpoints;
}

function endpointsOfFile(file: string): Endpoint[] {
  const ext = path.extname(file);
  if (ext !== ".java" && ext !== ".kt" && ext !== ".ts" && ext !== ".js") return [];
  let source: string;
  try {
    source = readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  return ext === ".java" || ext === ".kt" ? springEndpoints(source, file) : nodeEndpoints(source, file);
}

function springEndpoints(source: string, file: string): Endpoint[] {
  if (!/@(Rest)?Controller\b/.test(source)) return [];
  const classMatch = source.match(/\b(?:class|interface)\s+(\w+)/);
  if (!classMatch || classMatch.index === undefined) return [];
  const classAt = classMatch.index;

  const header = source.slice(0, classAt);
  const prefixes = annotationPaths(header, "RequestMapping") ?? [""];
  const tag = header.match(/@Tag\s*\(\s*name\s*=\s*"([^"]*)"/)?.[1];
  const body = source.slice(classAt);
  const endpoints: Endpoint[] = [];

  const pattern = /@(Get|Post|Put|Delete|Patch|Request)Mapping\b(\s*\(([^)]*)\))?/g;
  for (const match of body.matchAll(pattern)) {
    const args = match[3] ?? "";
    const paths = literalPaths(args);
    const method =
      match[1] === "Request" ? (args.match(/RequestMethod\.(\w+)/)?.[1] ?? null) : match[1].toUpperCase();
    // The method signature after the annotation (and any others stacked on it).
    const after = body.slice((match.index ?? 0) + match[0].length);
    const handler = after.match(/(?:public|protected|private|fun)\s+[^;{=]*?\b(\w+)\s*\(/)?.[1];
    for (const prefix of prefixes) {
      for (const sub of paths.length ? paths : [""]) {
        const route = joinRoute(prefix, sub);
        endpoints.push({ method, path: route, segments: pathSegments(route), handler, controller: classMatch[1], tag, file });
      }
    }
  }
  return endpoints;
}

function nodeEndpoints(source: string, file: string): Endpoint[] {
  const endpoints: Endpoint[] = [];

  // NestJS: @Controller('users') ... @Get(':id')
  const controller = source.match(/@Controller\(\s*(?:['"`]([^'"`]*)['"`])?/);
  if (controller) {
    const prefix = controller[1] ?? "";
    const className = source.match(/\bclass\s+(\w+)/)?.[1];
    for (const match of source.matchAll(/@(Get|Post|Put|Delete|Patch|All)\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/g)) {
      const route = joinRoute(prefix, match[2] ?? "");
      const after = source.slice((match.index ?? 0) + match[0].length);
      endpoints.push({
        method: match[1] === "All" ? null : match[1].toUpperCase(),
        path: route,
        segments: pathSegments(route),
        handler: after.match(/^\s*(?:async\s+)?(\w+)\s*\(/)?.[1],
        controller: className,
        file,
      });
    }
  }

  // Express / Fastify / Koa routers: router.get('/x', ...)
  for (const match of source.matchAll(/\b(?:app|router|server|fastify)\.(get|post|put|delete|patch|all)\(\s*['"`]([^'"`]+)['"`]/g)) {
    endpoints.push({
      method: match[1] === "all" ? null : match[1].toUpperCase(),
      path: joinRoute("", match[2]),
      segments: pathSegments(match[2]),
      file,
    });
  }
  return endpoints;
}

function joinRoute(prefix: string, sub: string): string {
  return `/${[prefix, sub].map((part) => part.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/")}`;
}

/** Paths in the last `@Name(...)` before the class; null when it has none we can read. */
function annotationPaths(header: string, name: string): string[] | null {
  const matches = [...header.matchAll(new RegExp(`@${name}\\b\\s*\\(([^)]*)\\)`, "g"))];
  if (!matches.length) return null;
  const paths = literalPaths(matches[matches.length - 1][1]);
  return paths.length ? paths : null;
}

/** String literals in an annotation's arguments that are paths, not media types. */
function literalPaths(args: string): string[] {
  const withoutMedia = args.replace(/\b(produces|consumes|headers|params)\s*=\s*(\{[^}]*\}|"[^"]*"|\w[\w.]*)/g, "");
  return [...withoutMedia.matchAll(/"([^"]*)"/g)].map((match) => match[1]);
}

function pathSegments(route: string): string[] {
  return route
    .split("/")
    .filter(Boolean)
    .map((segment) => (/^\{.*\}$/.test(segment) || segment.startsWith(":") ? "{}" : segment));
}

function matches(call: ApiCall, endpoint: Endpoint): boolean {
  if (call.method && endpoint.method && call.method !== endpoint.method) return false;
  const server = endpoint.segments;
  if (server.length > call.segments.length) return false;
  const tail = call.segments.slice(call.segments.length - server.length);
  return server.every((segment, index) => segment === "{}" || tail[index] === "{}" || segment === tail[index]);
}

// --- Files ---------------------------------------------------------------

function* walk(folder: string): Generator<string> {
  const stack = [folder];
  let seen = 0;
  while (stack.length) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) stack.push(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        if (++seen > MAX_SERVER_FILES) return;
        yield path.join(dir, entry.name);
      }
    }
  }
}

function isFile(file: string): boolean {
  return existsSync(file) && statSync(file).isFile();
}

function displayPath(file: string, roots: ProjectRoot[]): string {
  for (const root of roots) {
    const relative = path.relative(root.path, file);
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
      return roots.length > 1 ? `${root.role.toUpperCase()}: ${relative.split(path.sep).join("/")}` : relative.split(path.sep).join("/");
    }
  }
  return file;
}
