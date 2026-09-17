import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Locations the UI reads and writes, all resolved from this file rather than
 * from the caller's working directory — the server is started from wherever
 * the user happens to be standing, and the pipeline it launches changes its
 * own process's cwd besides.
 */

const uiDir = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(uiDir, "..", "..");

/** Browser assets. Served from source: the `aidev` launcher runs src/ via tsx. */
export const publicDir = path.join(uiDir, "public");

/** Where RunLogger writes each run's log.json and report.md. */
export const runsDir = path.join(repoRoot, "runs");

/** Per-machine UI state (saved presets). Gitignored, never holds a secret. */
export const uiStateFile = path.join(repoRoot, ".aidev-ui.json");

/** Default home for specs written in the UI's editor. */
export const specsDir = path.join(repoRoot, "specs");
