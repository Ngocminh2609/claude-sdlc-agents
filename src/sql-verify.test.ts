import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseEventLine } from "./events.js";
import { sqlFilesOf, type ProposedStep } from "./sql-file.js";
import type { ProbeRun, SqlProbe } from "./sql-probe.js";
import { applyStepsVerified, compareRuns, parseTestCalls, testPlanFor } from "./sql-verify.js";
import { runModeOfLog } from "./ui/runs.js";

const run = (...sets: unknown[][][]): ProbeRun => ({ calls: [{ resultSets: sets, ms: [10, 12, 11] }] });

describe("compareRuns", () => {
  it("passes only identical result sets, and says how others differ", () => {
    expect(compareRuns(run([[1, "a"]]), run([[1, "a"]]))).toMatchObject({ same: true });
    expect(compareRuns(run([[1], [2]]), run([[2], [1]])).detail).toMatch(/different order/);
    expect(compareRuns(run([[1]]), run([[1], [2]])).detail).toMatch(/1 row\(s\) before, 2 now/);
    expect(compareRuns(run([[1]]), run([[9]])).detail).toMatch(/different values/);
    expect(compareRuns(run([[1]]), { setupError: "Invalid object name 'X'", calls: [] }).detail).toMatch(/no longer run/);
  });

  it("treats the same error as the same outcome", () => {
    const failing = (error: string): ProbeRun => ({ calls: [{ resultSets: [], ms: [], error }] });
    expect(compareRuns(failing("divide by zero"), failing("divide by zero")).same).toBe(true);
    expect(compareRuns(failing("divide by zero"), run([[1]])).same).toBe(false);
  });
});

describe("testPlanFor / parseTestCalls", () => {
  it("runs a plain script as its own test, and needs calls for procedures", () => {
    const script = testPlanFor("SELECT id FROM t WHERE x = 1;", []);
    expect("skip" in script).toBe(false);
    if (!("skip" in script)) expect(script.callsOf("SELECT 2;")).toEqual(["SELECT 2;"]);
    expect(testPlanFor("CREATE OR ALTER PROCEDURE dbo.p AS SELECT 1", [])).toMatchObject({ skip: expect.stringMatching(/test calls/) });
    const proc = testPlanFor("CREATE PROCEDURE dbo.p AS SELECT 1", ["EXEC dbo.p"]);
    if (!("skip" in proc)) expect([proc.setupOf("DEF"), proc.callsOf("DEF")]).toEqual(["DEF", ["EXEC dbo.p"]]);
  });

  it("reads one call per line, skipping blanks and comments", () => {
    expect(parseTestCalls("EXEC a 1\n\n-- note\n  EXEC b 2  ")).toEqual(["EXEC a 1", "EXEC b 2"]);
  });
});

describe("applyStepsVerified", () => {
  const step = (index: number, before: string, after: string): ProposedStep & { index: number } => ({
    index,
    statement: "q",
    category: "existence-check",
    title: `step ${index}`,
    edits: [{ before, after }],
    why: "faster",
    equivalence: "same",
  });

  // A fake database: the query's "result" is the number after FILTER; "SLOW"/"FAST" set the timing.
  const probe: SqlProbe = {
    dialect: "postgresql",
    describeTables: async () => "",
    async runRolledBack(_setup, calls) {
      const sql = calls[0];
      const filter = Number(/FILTER (\d+)/.exec(sql)?.[1] ?? 0);
      const ms = sql.includes("FAST") ? 2 : 20;
      return { calls: [{ resultSets: [[[filter]]], ms: [ms, ms, ms] }] };
    },
    close: async () => {},
  };

  it("keeps a step only when the database returns the original's results, and times each one", async () => {
    const progress: string[] = [];
    const result = await applyStepsVerified({
      original: "SELECT SLOW FILTER 5;",
      steps: [step(1, "SLOW", "FAST"), step(2, "FILTER 5", "FILTER 6")],
      rejectedUpFront: new Map(),
      probe,
      plan: { setupOf: () => "", callsOf: (text) => [text], describe: "the script itself" },
      repeats: 3,
      onProgress: (line) => progress.push(line),
    });
    expect(result.text).toBe("SELECT FAST FILTER 5;");
    expect(result.outcomes[0]).toMatchObject({ status: "applied", db: { verdict: "identical", msBefore: 20, msAfter: 2 } });
    expect(result.outcomes[1]).toMatchObject({ status: "rejected", db: { verdict: "differs" } });
    expect(result.outcomes[1].rejectedBecause).toMatch(/test database gave different results/);
    expect(progress).toContain("SQL verify: step 1 — identical results, 20 → 2 ms");
  });
});

describe("folders, events and history", () => {
  it("lists a folder's .sql files, leaving out earlier outputs", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "aidev-sqlfiles-"));
    try {
      for (const name of ["b.sql", "a.SQL", "a_optimized.sql", "notes.txt"]) await writeFile(path.join(dir, name), "SELECT 1;");
      expect(sqlFilesOf(dir).map((file) => path.basename(file))).toEqual(["a.SQL", "b.sql"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("carries every file's steps, with database checks, to the UI", () => {
    const event = parseEventLine(
      JSON.stringify({
        type: "sql-steps",
        files: [
          {
            source: "/x/a.sql",
            outputPath: "/x/a_optimized.sql",
            verification: "1 call, 20 ms → 2 ms",
            steps: [
              {
                index: 1,
                status: "applied",
                statement: "q",
                category: "set-based",
                title: "t",
                edits: [{ before: "a", after: "b" }],
                why: "w",
                equivalence: "e",
                lines: [3],
                db: { verdict: "identical", detail: "1 call(s): identical results", msBefore: 20, msAfter: 2 },
              },
            ],
          },
          { source: "/x/big.sql", outputPath: null, error: "too large", steps: [] },
        ],
      }),
    );
    expect(event).toMatchObject({ type: "sql-steps", files: [{ steps: [{ lines: [3], db: { msAfter: 2 } }] }, { error: "too large" }] });
  });

  it("lists SQL runs as their own flow in the history", () => {
    expect(runModeOfLog({ mode: "sql" }, "2026-10-16T00-00-00-000Z-SQL-sql-a")).toBe("sql");
  });
});
