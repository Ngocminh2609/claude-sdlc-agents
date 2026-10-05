import { describe, expect, it } from "vitest";
import { checkFailures, summarizeReport } from "./e2e-check.js";
import type { E2eCheck } from "./types.js";

const attach = (problems: unknown[]) => ({
  name: "aidev-api-problems",
  contentType: "application/json",
  body: Buffer.from(JSON.stringify(problems)).toString("base64"),
});

const report = {
  suites: [
    {
      title: "units.spec.ts",
      specs: [
        { title: "lists units", tests: [{ status: "expected", projectName: "chromium", results: [{ status: "passed", attachments: [attach([])] }] }] },
        {
          title: "saves a unit",
          tests: [
            {
              status: "unexpected",
              projectName: "chromium",
              results: [
                {
                  status: "failed",
                  attachments: [attach([{ kind: "http", method: "POST", url: "http://localhost:5173/api/units", status: 500 }])],
                },
              ],
            },
          ],
        },
      ],
      suites: [
        {
          title: "search",
          specs: [{ title: "finds by name", tests: [{ status: "expected", results: [{ status: "passed", attachments: [] }] }] }],
        },
      ],
    },
  ],
};

describe("summarizeReport", () => {
  it("counts outcomes, collects the guard's API problems, and spots tests the guard never saw", () => {
    const summary = summarizeReport(report as never);

    expect(summary).toMatchObject({ total: 3, passed: 2, failed: 1, flaky: 0, skipped: 0 });
    expect(summary.failedTests).toEqual(["units.spec.ts › saves a unit [chromium]"]);
    expect(summary.apiProblems).toEqual([
      { test: "units.spec.ts › saves a unit [chromium]", kind: "http", method: "POST", url: "http://localhost:5173/api/units", status: 500 },
    ]);
    expect(summary.unguardedTests).toEqual(["units.spec.ts › search › finds by name"]);
  });

  it("is empty for a report with no suites", () => {
    expect(summarizeReport({})).toMatchObject({ total: 0, apiProblems: [], unguardedTests: [] });
  });
});

describe("checkFailures", () => {
  const clean: E2eCheck = {
    ran: true,
    total: 1,
    passed: 1,
    failed: 0,
    flaky: 0,
    skipped: 0,
    failedTests: [],
    unguardedTests: [],
    apiProblems: [],
    evidenceDir: "/e",
  };

  it("has nothing to say about a clean run", () => {
    expect(checkFailures(clean)).toEqual([]);
  });

  it("treats no tests, flaky tests and skipped tests as not verified", () => {
    expect(checkFailures({ ...clean, total: 0, passed: 0 })).toEqual(["Playwright found no tests to run."]);
    expect(checkFailures({ ...clean, flaky: 1 })[0]).toMatch(/flaky/);
    expect(checkFailures({ ...clean, skipped: 1 })[0]).toMatch(/skipped/);
  });

  it("says why when the run itself could not happen", () => {
    expect(checkFailures({ ...clean, ran: false, error: "timed out" })).toEqual([
      "The pipeline's own Playwright run did not complete: timed out",
    ]);
  });
});
