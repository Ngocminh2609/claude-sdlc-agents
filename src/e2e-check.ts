import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { config } from "./config.js";
import { killTree } from "./kill-tree.js";
import {
  evidencePaths,
  findProjectConfig,
  GUARD_ATTACHMENT,
  WRAPPER_CONFIG_FILE,
  writeGuard,
  writeWrapperConfig,
} from "./e2e-guard.js";
import type { E2eApiProblem, E2eCheck, E2eVerdict } from "./types.js";

/**
 * The pipeline's own run of the E2E agent's Playwright tests, judged from
 * Playwright's JSON results instead of from the agent's summary. Plain code:
 * whether E2E passed is not something the agent gets the last word on.
 */

interface JsonAttachment {
  name: string;
  contentType?: string;
  body?: string;
}

interface JsonResult {
  status: string;
  attachments?: JsonAttachment[];
  errors?: { message?: string }[];
}

interface JsonTest {
  status: "expected" | "unexpected" | "flaky" | "skipped";
  projectName?: string;
  results: JsonResult[];
}

interface JsonSpec {
  title: string;
  file?: string;
  tests: JsonTest[];
}

interface JsonSuite {
  title: string;
  specs?: JsonSpec[];
  suites?: JsonSuite[];
}

interface JsonReport {
  suites?: JsonSuite[];
  errors?: { message?: string }[];
}

/** Reads what the guard attached to a result: the problems it saw, or null when it never ran. */
function guardProblems(result: JsonResult): Omit<E2eApiProblem, "test">[] | null {
  const attachment = result.attachments?.find((candidate) => candidate.name === GUARD_ATTACHMENT);
  if (!attachment?.body) return null;
  // The JSON reporter base64-encodes in-memory attachment bodies.
  for (const text of [Buffer.from(attachment.body, "base64").toString("utf-8"), attachment.body]) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed as Omit<E2eApiProblem, "test">[];
    } catch {
      // Try the other encoding.
    }
  }
  return null;
}

/** Turns Playwright's JSON report into the check the verdict is decided on. */
export function summarizeReport(report: JsonReport): Omit<E2eCheck, "ran" | "evidenceDir"> {
  const check: Omit<E2eCheck, "ran" | "evidenceDir"> = {
    total: 0,
    passed: 0,
    failed: 0,
    flaky: 0,
    skipped: 0,
    failedTests: [],
    unguardedTests: [],
    apiProblems: [],
  };

  const walk = (suite: JsonSuite, trail: string[]) => {
    const path = suite.title ? [...trail, suite.title] : trail;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        const name = [...path, spec.title].join(" › ") + (test.projectName ? ` [${test.projectName}]` : "");
        check.total++;
        if (test.status === "skipped") {
          check.skipped++;
          continue;
        }
        if (test.status === "expected") check.passed++;
        else if (test.status === "flaky") check.flaky++;
        else check.failed++;
        if (test.status !== "expected") check.failedTests.push(name);

        const last = test.results.at(-1);
        const problems = last ? guardProblems(last) : null;
        if (problems === null) check.unguardedTests.push(name);
        else check.apiProblems.push(...problems.map((problem) => ({ ...problem, test: name })));
      }
    }
    for (const child of suite.suites ?? []) walk(child, path);
  };
  for (const suite of report.suites ?? []) walk(suite, []);
  return check;
}

/** Why a check is not a pass, one line each; empty when it is one. */
export function checkFailures(check: E2eCheck): string[] {
  if (!check.ran) return [`The pipeline's own Playwright run did not complete: ${check.error ?? "unknown error"}`];
  const reasons: string[] = [];
  if (check.total === 0) reasons.push("Playwright found no tests to run.");
  if (check.failed) reasons.push(`${check.failed} test(s) failed: ${check.failedTests.join("; ")}`);
  if (check.flaky) reasons.push(`${check.flaky} test(s) only passed on retry (flaky) — not counted as verified.`);
  if (check.skipped) reasons.push(`${check.skipped} test(s) were skipped — a skipped test verifies nothing.`);
  if (check.unguardedTests.length) {
    reasons.push(
      `${check.unguardedTests.length} test(s) did not use the API guard (import test/expect from e2e/aidev-guard): ${check.unguardedTests.join("; ")}`,
    );
  }
  for (const problem of check.apiProblems) {
    const what =
      problem.kind === "http"
        ? `${problem.method} ${problem.url} answered HTTP ${problem.status}`
        : problem.kind === "network"
          ? `${problem.method} ${problem.url} failed: ${problem.message}`
          : `page error on ${problem.url}: ${problem.message}`;
    reasons.push(`API problem in "${problem.test}": ${what}`);
  }
  return reasons;
}

/**
 * The final verdict: a pass only when the agent says pass AND the pipeline's
 * own run agrees — tests exist, none failed, flaked or was skipped, every one
 * ran under the guard, and the guard saw no API problem.
 */
export function combineVerdict(agent: E2eVerdict, check: E2eCheck): E2eVerdict {
  const reasons = checkFailures(check);
  const passed = agent.verdict === "pass" && reasons.length === 0;
  const checkLine = reasons.length
    ? `Pipeline check: FAILED — ${reasons.length} problem(s).`
    : `Pipeline check: ${check.passed}/${check.total} test(s) passed under the API guard, no API errors.`;
  return {
    ...agent,
    verdict: passed ? "pass" : "fail",
    summary: `${agent.summary}\n\n${checkLine}`,
    failedScenarios: [...(agent.failedScenarios ?? []), ...reasons],
    check,
  };
}

/** Writes the guard into the E2E folder before the agent writes its tests. */
export async function prepareE2e(e2eRoot: string): Promise<void> {
  await writeGuard(e2eRoot);
}

/**
 * Rewrites the guard and the wrapper config, runs the agent's tests once with
 * evidence capture on, and summarises the JSON results. Never throws: a run
 * that cannot happen is a check that did not pass, with the reason.
 */
export async function runE2eCheck(
  e2eRoot: string,
  evidenceDir: string,
  onProgress: (message: string) => void = () => {},
): Promise<E2eCheck> {
  const evidence = evidencePaths(evidenceDir);
  const notRun = (error: string): E2eCheck => ({ ...summarizeReport({}), ran: false, error, evidenceDir });

  const projectConfig = findProjectConfig(e2eRoot);
  if (!projectConfig) return notRun(`no playwright.config.* in ${e2eRoot}, where the E2E tests were to be set up`);

  await writeGuard(e2eRoot);
  await rm(evidenceDir, { recursive: true, force: true });
  await writeWrapperConfig(e2eRoot, projectConfig, evidence);

  onProgress("E2E/QA check: running the tests again with the API guard and evidence capture");
  const exit = await runPlaywright(e2eRoot);
  if (exit.timedOut) return notRun(`Playwright did not finish within ${config.e2eCheckTimeoutMs / 60000} minutes`);

  let report: JsonReport;
  try {
    report = JSON.parse(await readFile(evidence.json, "utf-8")) as JsonReport;
  } catch {
    return notRun(`Playwright exited with code ${exit.code} without writing results. Last output:\n${exit.tail}`);
  }
  const check: E2eCheck = { ...summarizeReport(report), ran: true, evidenceDir };
  // A config or global-setup error fails before any test, with an empty suite list.
  if (!check.total && report.errors?.length) {
    return { ...check, ran: false, error: report.errors.map((error) => error.message ?? "").join("\n").slice(0, 2000) };
  }
  return check;
}

/**
 * `npx playwright test` with the wrapper config. Through a shell because npx
 * is a .cmd on Windows; the command line is a constant, nothing user-provided
 * is interpolated into it.
 */
function runPlaywright(cwd: string): Promise<{ code: number | null; timedOut: boolean; tail: string }> {
  return new Promise((resolve) => {
    const child = spawn(`npx playwright test --config=${WRAPPER_CONFIG_FILE}`, {
      cwd,
      shell: true,
      windowsHide: true,
      // Its own process group on POSIX, so a timeout can stop the web servers Playwright started too.
      detached: process.platform !== "win32",
      env: { ...process.env, CI: "1" },
    });
    let tail = "";
    const keep = (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      process.stderr.write(text);
      tail = (tail + text).slice(-4000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, config.e2eCheckTimeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, tail });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, timedOut, tail: `${tail}\n${error.message}` });
    });
  });
}
