#!/usr/bin/env node
// Global entry point for the pipeline, installed as the `aidev` command via
// `npm link` (see the `bin` field in package.json).
//
// Two things this wrapper does that a bare `bin` -> source mapping cannot:
//
// 1. Credentials. The pipeline reads ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN
//    from the environment, but once the command is callable from any directory
//    there is no longer a shell session in the repo to have exported them. So
//    load this repo's own .env, regardless of the caller's cwd.
// 2. TypeScript. `bin` points here rather than at dist/ on purpose: running the
//    source through tsx means an edit to src/ takes effect immediately, with no
//    build step to forget and no way to silently run a stale dist/.

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// process.loadEnvFile landed in Node 20.12 — hence the engines floor in
// package.json. Fail with a readable message rather than a bare TypeError.
if (typeof process.loadEnvFile !== "function") {
  console.error(`aidev: needs Node 20.12 or newer to read .env (running ${process.version}).`);
  process.exit(1);
}

const envFile = path.join(repoRoot, ".env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

// Resolve tsx through its package manifest instead of hardcoding
// node_modules/tsx/dist/cli.mjs, so an upgrade that moves the entry point
// doesn't silently break the command.
const require = createRequire(import.meta.url);
let tsxCli;
try {
  const manifestPath = require.resolve("tsx/package.json", { paths: [repoRoot] });
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const binEntry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.tsx;
  if (!binEntry) throw new Error("tsx package.json declares no bin entry");
  tsxCli = path.resolve(path.dirname(manifestPath), binEntry);
} catch (error) {
  console.error(`aidev: cannot find tsx in ${repoRoot}. Run \`npm install\` there first.`);
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
}

// Invoke tsx via the current node binary rather than the node_modules/.bin
// shim: on Windows that shim is a .cmd file, which Node refuses to spawn
// without shell:true, and shell:true would then mangle any argument
// containing a space (e.g. --project "C:\Program Files\app").
const result = spawnSync(
  process.execPath,
  [tsxCli, path.join(repoRoot, "src", "index.ts"), ...process.argv.slice(2)],
  { stdio: "inherit" },
);

if (result.error) {
  console.error(`aidev: failed to start the pipeline: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
