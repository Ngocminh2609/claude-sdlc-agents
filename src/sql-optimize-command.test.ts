import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const proposeSqlSteps = vi.fn();
const checkSqlSteps = vi.fn();
vi.mock("./stages/sql-optimize.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./stages/sql-optimize.js")>()),
  proposeSqlSteps,
  checkSqlSteps,
}));

const { runSqlOptimize } = await import("./sql-optimize-command.js");
const { CHUNK_TARGET_CHARS } = await import("./sql-chunks.js");

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "aidev-sqlcmd-"));
  process.env.AIDEV_RUNS_DIR = path.join(dir, "runs");
  proposeSqlSteps.mockReset();
  checkSqlSteps.mockReset();
});
afterEach(async () => {
  delete process.env.AIDEV_RUNS_DIR;
  await rm(dir, { recursive: true, force: true });
});

// Every procedure holds the same slow check: as one file, its code is never unique.
const proc = (i: number) =>
  [
    `CREATE OR ALTER PROCEDURE dbo.usp_${i} AS`,
    "BEGIN",
    "    IF (SELECT COUNT(*) FROM dbo.Orders o WHERE o.Status = 'PAID') > 0",
    `        SELECT o.Id, o.Total FROM dbo.Orders o WHERE o.Status = 'PAID' AND o.Region = ${i};`,
    ...Array.from({ length: 40 }, (_, line) => `    -- filler ${line} keeps each procedure a realistic size for the splitter`),
    "END",
    "GO",
    "",
  ].join("\n");

describe("runSqlOptimize on a file larger than one part", () => {
  it("optimizes part by part, applies each edit in its own part, and writes one file", async () => {
    const text = Array.from({ length: 80 }, (_, i) => proc(i)).join("");
    expect(text.length).toBeGreaterThan(CHUNK_TARGET_CHARS * 2);
    const file = path.join(dir, "big.sql");
    await writeFile(file, text);

    const exists = {
      statement: "existence check",
      category: "existence-check",
      title: "EXISTS instead of COUNT(*) > 0",
      edits: [
        {
          before: "IF (SELECT COUNT(*) FROM dbo.Orders o WHERE o.Status = 'PAID') > 0",
          after: "IF EXISTS (SELECT 1 FROM dbo.Orders o WHERE o.Status = 'PAID')",
        },
      ],
      why: "stops at the first row",
      equivalence: "same truth value",
    };
    // One step per part: the part's first procedure only, so its code is unique within the part.
    proposeSqlSteps.mockImplementation(async (input: { sql: string }) => {
      const first = /CREATE OR ALTER PROCEDURE dbo\.(usp_\d+)/.exec(input.sql)?.[1];
      // The part's first procedure only: its check plus its own SELECT line is unique within the part.
      const [, , check, select] = input.sql.split("\n");
      return {
        dialect: "sqlserver",
        steps: [{ ...exists, statement: `dbo.${first}`, edits: [{ before: `${check}\n${select}`, after: `${exists.edits[0].after}\n${select}` }] }],
        warnings: [],
        indexSuggestions: ["CREATE INDEX IX_Orders_Status ON dbo.Orders (Status);"],
      };
    });
    checkSqlSteps.mockImplementation(async (_input: unknown, steps: unknown[]) => new Map(steps.map((_, i) => [i + 1, { verdict: "same-results", reason: "ok" }])));

    const progress: string[] = [];
    let reported = { status: "", message: "" };
    await runSqlOptimize(
      { file, overwrite: false },
      { onProgress: (line) => progress.push(line), emitFiles: () => {}, report: (status, message) => (reported = { status, message }) },
    );

    const parts = proposeSqlSteps.mock.calls.length;
    expect(parts).toBeGreaterThan(1);
    expect(progress).toContain(`SQL optimize: ${parts} part(s) — each is optimized and checked on its own, then they are put back together`);
    expect(reported.status).toBe("done");

    const output = await readFile(path.join(dir, "big_optimized.sql"), "utf-8");
    const body = output.slice(output.indexOf("CREATE OR ALTER PROCEDURE dbo.usp_0"));
    // Exactly one EXISTS per part, each in that part's first procedure; everything else untouched.
    expect(body.match(/IF EXISTS/g)).toHaveLength(parts);
    const restored = body.replace(/IF EXISTS \(SELECT 1 FROM dbo\.Orders o WHERE o\.Status = 'PAID'\)/g, "IF (SELECT COUNT(*) FROM dbo.Orders o WHERE o.Status = 'PAID') > 0");
    expect(restored).toBe(text);
    // Steps are numbered across the file, with lines in the output file.
    expect(output).toContain("-- Step 1: EXISTS instead of COUNT(*) > 0");
    expect(output).toContain(`-- Step ${parts}: EXISTS instead of COUNT(*) > 0`);
    const lastLine = Number(/-- Step \d+:[\s\S]*?Before \(line (\d+)\)[\s\S]*$/.exec(output)?.[1]);
    expect(body.split("\n")[lastLine - 1]).toContain("IF EXISTS");
    // The same index suggestion from every part appears once.
    expect(output.match(/CREATE INDEX IX_Orders_Status/g)).toHaveLength(1);
  });

  it("has no fixed length limit, and refuses a file over a cap the person set, before any model call", async () => {
    const file = path.join(dir, "long.sql");
    await writeFile(file, Array.from({ length: 12_000 }, (_, i) => `SELECT ${i} AS n FROM dbo.Orders WHERE Id = ${i};\n`).join("") + "GO\n");
    proposeSqlSteps.mockResolvedValue({ dialect: "sqlserver", steps: [], warnings: [], indexSuggestions: [] });
    const io = (sink: { status: string; message: string }, progress: string[] = []) => ({
      onProgress: (line: string) => progress.push(line),
      emitFiles: () => {},
      report: (status: string, message: string) => Object.assign(sink, { status, message }),
    });

    const progress: string[] = [];
    const done = { status: "", message: "" };
    await runSqlOptimize({ file, overwrite: true }, io(done, progress));
    expect(done.status).toBe("done");
    expect(proposeSqlSteps.mock.calls.length).toBeGreaterThan(1);
    expect(progress.some((line) => /about \d+ AI call\(s\) for this file/.test(line))).toBe(true);

    proposeSqlSteps.mockClear();
    process.env.AIDEV_SQL_MAX_CHARS = "100000";
    try {
      const refused = { status: "", message: "" };
      await runSqlOptimize({ file, overwrite: true }, io(refused));
      expect(proposeSqlSteps).not.toHaveBeenCalled();
      expect(refused.status).toBe("errored");
      expect(refused.message).toContain("the limit is 100,000");
    } finally {
      delete process.env.AIDEV_SQL_MAX_CHARS;
    }
  });

  it("stops at the run budget: parts done are written, parts not reached stay as they were", async () => {
    const { setRunBudget } = await import("./run-budget.js");
    const { recordUsage, resetUsage, emptyUsage } = await import("./token-usage.js");
    const text = Array.from({ length: 80 }, (_, i) => proc(i)).join("");
    const file = path.join(dir, "big.sql");
    await writeFile(file, text);
    // Each part's proposal costs $1; the cap is $1, so only the first part gets through.
    proposeSqlSteps.mockImplementation(async (input: { sql: string }) => {
      recordUsage({ ...emptyUsage(), costUsd: 1 });
      const [, , check, select] = input.sql.split("\n");
      return {
        dialect: "sqlserver",
        steps: [{ statement: "q", category: "existence-check", title: "EXISTS", edits: [{ before: `${check}\n${select}`, after: `    IF EXISTS (SELECT 1 FROM dbo.Orders o WHERE o.Status = 'PAID')\n${select}` }], why: "w", equivalence: "e" }],
        warnings: [],
        indexSuggestions: [],
      };
    });
    checkSqlSteps.mockImplementation(async () => new Map([[1, { verdict: "same-results", reason: "ok" }]]));
    setRunBudget(1);
    try {
      const reported = { status: "", message: "" };
      await runSqlOptimize({ file, overwrite: false }, { onProgress: () => {}, emitFiles: () => {}, report: (status, message) => Object.assign(reported, { status, message }) });
      expect(proposeSqlSteps).toHaveBeenCalledTimes(1);
      expect(reported.status).toBe("budget-stopped");
      const output = await readFile(path.join(dir, "big_optimized.sql"), "utf-8");
      const code = output.split("\n").filter((line) => !line.startsWith("--")).join("\n");
      expect(code.match(/IF EXISTS/g)).toHaveLength(1);
      expect(output).toMatch(/Parts 2–\d+ left unchanged: run budget reached \(~\$1\.00 of \$1\.00\)/);
    } finally {
      setRunBudget(undefined);
      resetUsage();
    }
  });
});
