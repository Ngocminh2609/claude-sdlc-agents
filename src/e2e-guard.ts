import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * The files the pipeline itself puts into the target project for E2E, so that
 * "no API call failed" and "here is the evidence" are enforced by code rather
 * than taken from the E2E agent's own report.
 *
 * - `e2e/aidev-guard.ts`: a Playwright fixture every E2E test must import
 *   `test`/`expect` from. While a test runs it records every API call to the
 *   app (fetch/XHR to a loopback host) that answers 5xx, fails at the network
 *   level, or answers a 4xx the test did not declare — plus uncaught page
 *   errors — and fails the test if there were any. It always attaches what it
 *   saw, so a test with no attachment is a test that bypassed the guard.
 * - `aidev.playwright.config.ts`: the project's own Playwright config, with
 *   trace/screenshot/video forced on and the reports written into this run's
 *   evidence folder. Next to the project config so relative paths (testDir,
 *   webServer cwd) mean the same thing.
 *
 * Both are rewritten right before the pipeline's own Playwright run, so an edit
 * by the agent cannot weaken them.
 */

export const GUARD_FILE = path.join("e2e", "aidev-guard.ts");
export const WRAPPER_CONFIG_FILE = "aidev.playwright.config.ts";
/** Name of the attachment the guard adds to every test result. */
export const GUARD_ATTACHMENT = "aidev-api-problems";

const PROJECT_CONFIG_NAMES = ["playwright.config.ts", "playwright.config.mts", "playwright.config.js", "playwright.config.mjs", "playwright.config.cjs"];

const GUARD_SOURCE = `// Written by aidev before every E2E run, and rewritten before its own check — edits here are discarded.
// Import \`test\` and \`expect\` from this file in every E2E test. A test fails when, while it ran, an API
// call to the app (fetch/XHR to localhost) answered 5xx, failed at the network level, or answered a 4xx
// the test did not declare with apiGuard.allow(), or when the page threw an uncaught error.
import { test as base, expect, type Page, type Request } from "@playwright/test";

export { expect };

export interface ApiProblem {
  kind: "http" | "network" | "page-error";
  method?: string;
  url: string;
  status?: number;
  message?: string;
}

export interface ApiGuard {
  /**
   * Declares an error response this test provokes on purpose, e.g. allow(400, /\\/api\\/units/) in a
   * "rejects an invalid code" test. Only 4xx can be allowed: a 5xx is always a defect.
   */
  allow(status: number, url?: RegExp | string): void;
}

interface GuardState {
  problems: ApiProblem[];
  allowed: { status: number; url?: RegExp | string }[];
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function isAppApiCall(request: Request): boolean {
  if (!["fetch", "xhr"].includes(request.resourceType())) return false;
  try {
    return LOOPBACK.has(new URL(request.url()).hostname);
  } catch {
    return false;
  }
}

function matches(pattern: RegExp | string | undefined, url: string): boolean {
  if (pattern === undefined) return true;
  return typeof pattern === "string" ? url.includes(pattern) : pattern.test(url);
}

function describe(problem: ApiProblem): string {
  if (problem.kind === "http") return \`  \${problem.method} \${problem.url} -> HTTP \${problem.status}\`;
  if (problem.kind === "network") return \`  \${problem.method} \${problem.url} -> \${problem.message}\`;
  return \`  page error on \${problem.url}: \${problem.message}\`;
}

export const test = base.extend<{ apiGuard: ApiGuard; aidevGuardState: GuardState; aidevGuard: void }>({
  aidevGuardState: async ({}, use) => {
    await use({ problems: [], allowed: [] });
  },

  apiGuard: async ({ aidevGuardState }, use) => {
    await use({
      allow(status, url) {
        if (status >= 500) throw new Error("apiGuard.allow: a 5xx response cannot be allowed — it is always a defect.");
        aidevGuardState.allowed.push({ status, url });
      },
    });
  },

  aidevGuard: [
    async ({ context, aidevGuardState: state }, use, testInfo) => {
      context.on("response", (response) => {
        const request = response.request();
        if (!isAppApiCall(request) || response.status() < 400) return;
        state.problems.push({ kind: "http", method: request.method(), url: request.url(), status: response.status() });
      });
      context.on("requestfailed", (request) => {
        if (!isAppApiCall(request)) return;
        const message = request.failure()?.errorText ?? "request failed";
        // Leaving a page cancels its in-flight calls; that is navigation, not a failing API.
        if (/ERR_ABORTED|NS_BINDING_ABORTED|cancelled/i.test(message)) return;
        state.problems.push({ kind: "network", method: request.method(), url: request.url(), message });
      });
      const watch = (page: Page) =>
        page.on("pageerror", (error) => state.problems.push({ kind: "page-error", url: page.url(), message: error.message }));
      context.pages().forEach(watch);
      context.on("page", watch);

      await use();

      const unexpected = state.problems.filter(
        (problem) =>
          !(
            problem.kind === "http" &&
            (problem.status ?? 500) < 500 &&
            state.allowed.some((allowed) => allowed.status === problem.status && matches(allowed.url, problem.url))
          ),
      );
      await testInfo.attach("${GUARD_ATTACHMENT}", { body: JSON.stringify(unexpected), contentType: "application/json" });
      if (unexpected.length) {
        throw new Error(
          \`aidev API guard: \${unexpected.length} problem(s) while this test ran:\\n\${unexpected.map(describe).join("\\n")}\`,
        );
      }
    },
    { auto: true },
  ],
});
`;

/** The project's own Playwright config in `root`, or null when the E2E agent did not leave one there. */
export function findProjectConfig(root: string): string | null {
  return PROJECT_CONFIG_NAMES.find((name) => existsSync(path.join(root, name))) ?? null;
}

/** Writes the guard fixture into `root`/e2e. */
export async function writeGuard(root: string): Promise<void> {
  const file = path.join(root, GUARD_FILE);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, GUARD_SOURCE, "utf-8");
}

export interface EvidencePaths {
  /** Playwright's per-test output: traces, screenshots, videos. */
  results: string;
  /** The HTML report (index.html), which opens traces and videos in a browser. */
  htmlReport: string;
  /** The machine-readable results the pipeline judges from. */
  json: string;
}

export function evidencePaths(evidenceDir: string): EvidencePaths {
  return {
    results: path.join(evidenceDir, "results"),
    htmlReport: path.join(evidenceDir, "report"),
    json: path.join(evidenceDir, "results.json"),
  };
}

/** Writes the wrapper config around `projectConfig` (a file name in `root`). */
export async function writeWrapperConfig(root: string, projectConfig: string, evidence: EvidencePaths): Promise<void> {
  // A TypeScript config is imported without its extension, which Playwright's loader resolves.
  const importPath = `./${projectConfig.replace(/\.(ts|mts)$/, "")}`;
  const source = `// Written by aidev for its own E2E check — the project's Playwright config, with evidence capture forced on.
// Rewritten on every run; safe to delete.
import { defineConfig } from "@playwright/test";
import projectConfig from ${JSON.stringify(importPath)};

export default defineConfig({
  ...projectConfig,
  outputDir: ${JSON.stringify(evidence.results)},
  reporter: [
    ["list"],
    ["json", { outputFile: ${JSON.stringify(evidence.json)} }],
    ["html", { outputFolder: ${JSON.stringify(evidence.htmlReport)}, open: "never" }],
  ],
  use: { ...projectConfig.use, trace: "on", screenshot: "on", video: "on" },
});
`;
  await writeFile(path.join(root, WRAPPER_CONFIG_FILE), source, "utf-8");
}
