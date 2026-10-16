import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSqlOptimizeArgs } from "./cli-args.js";
import {
  applySteps,
  detectDialect,
  droppedReferences,
  logicReferences,
  optimizedPathOf,
  readSqlFile,
  renderOptimizedFile,
  writeSqlFile,
  type ProposedStep,
} from "./sql-file.js";
import { rejectionOf } from "./stages/sql-optimize.js";
import { stageOfProgress } from "./ui/stages.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "aidev-sql-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("optimizedPathOf", () => {
  it("adds _optimized before the extension, next to the original", () => {
    expect(optimizedPathOf(path.join(dir, "usp_Orders.sql"))).toBe(path.join(dir, "usp_Orders_optimized.sql"));
    expect(optimizedPathOf(path.join(dir, "query"))).toBe(path.join(dir, "query_optimized.sql"));
  });
});

describe("detectDialect", () => {
  it("recognises each dialect from syntax only it uses", () => {
    expect(detectDialect("CREATE PROCEDURE dbo.p AS BEGIN SET NOCOUNT ON; SELECT TOP 5 * FROM t WITH (NOLOCK) END\nGO")).toBe("sqlserver");
    expect(detectDialect("DELIMITER //\nCREATE PROCEDURE p() BEGIN SELECT `id` FROM `t` LIMIT 0, 10; END //")).toBe("mysql");
    expect(detectDialect("CREATE FUNCTION f() RETURNS SETOF t AS $$ SELECT * FROM t WHERE name ILIKE 'a%' $$ LANGUAGE plpgsql;")).toBe("postgresql");
  });

  it("does not guess from plain ANSI SQL or from comments", () => {
    expect(detectDialect("SELECT id, name FROM customers WHERE id = 1;")).toBeNull();
    expect(detectDialect("-- SET NOCOUNT ON\nSELECT 1;")).toBeNull();
  });
});

describe("readSqlFile / writeSqlFile", () => {
  it("writes back in the encoding and line endings it read", async () => {
    const source = path.join(dir, "a.sql");
    const text = "SELECT N'Đơn hàng'\r\nFROM t;\r\n";
    await writeFile(source, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]));

    const read = await readSqlFile(source);
    expect(read).toMatchObject({ text, encoding: "utf16le", eol: "\r\n" });

    const out = path.join(dir, "b.sql");
    await writeSqlFile(out, "SELECT 1\nFROM t;\n", read);
    const bytes = await readFile(out);
    expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(bytes.subarray(2).toString("utf16le")).toBe("SELECT 1\r\nFROM t;\r\n");
  });

  it("keeps a UTF-8 BOM", async () => {
    const source = path.join(dir, "a.sql");
    await writeFile(source, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("SELECT 1;\n")]));
    expect(await readSqlFile(source)).toMatchObject({ text: "SELECT 1;\n", encoding: "utf8-bom", eol: "\n" });
  });
});

const step = (before: string, after: string, extra: Partial<ProposedStep> = {}): ProposedStep => ({
  statement: "dbo.p — main SELECT",
  category: "existence-check",
  title: "EXISTS instead of COUNT(*)",
  edits: [{ before, after }],
  why: "Stops at the first row.",
  equivalence: "Same truth value.",
  ...extra,
});

const ORIGINAL = [
  "CREATE PROCEDURE dbo.p AS",
  "BEGIN",
  "  SELECT id FROM t",
  "  WHERE (SELECT COUNT(*)  FROM s WHERE s.id = t.id) > 0;",
  "  -- untouched business rule:",
  "  UPDATE t SET flag = 1 WHERE amount > 100;",
  "END",
].join("\n");

describe("applySteps", () => {
  it("applies each step in order, tolerating re-typed whitespace, and leaves every other line as it was", () => {
    const { text, outcomes } = applySteps(
      ORIGINAL,
      [
        { ...step("WHERE (SELECT COUNT(*) FROM s WHERE s.id = t.id) > 0;", "WHERE EXISTS (SELECT 1 FROM s WHERE s.id = t.id);"), index: 1 },
        { ...step("BEGIN", "BEGIN\n  SET NOCOUNT ON;", { category: "session-setting", title: "SET NOCOUNT ON" }), index: 2 },
      ],
      new Map(),
    );
    expect(outcomes.map((o) => [o.index, o.status, o.lines])).toEqual([
      [1, "applied", [4]],
      [2, "applied", [2]],
    ]);
    expect(text).toContain("  WHERE EXISTS (SELECT 1 FROM s WHERE s.id = t.id);");
    expect(text).toContain("  UPDATE t SET flag = 1 WHERE amount > 100;");
    const untouched = ORIGINAL.split("\n").filter((line) => !/COUNT|BEGIN/.test(line));
    for (const line of untouched) expect(text.split("\n")).toContain(line);
  });

  it("rejects a step whose code is missing or ambiguous, and one the check turned down, instead of guessing", () => {
    const { text, outcomes } = applySteps(
      "SELECT a FROM t;\nSELECT a FROM t;",
      [
        { ...step("SELECT a FROM t;", "SELECT a FROM t WITH (NOLOCK);"), index: 1 },
        { ...step("SELECT b FROM u;", "SELECT b FROM u2;"), index: 2 },
        { ...step("SELECT a", "SELECT DISTINCT a"), index: 3 },
      ],
      new Map([[3, "the check could not confirm the results stay the same"]]),
    );
    expect(text).toBe("SELECT a FROM t;\nSELECT a FROM t;");
    expect(outcomes.map((o) => o.rejectedBecause)).toEqual([
      "the code to replace occurs 2 times — not applied rather than guessed",
      "the code to replace was not found in the file",
      "the check could not confirm the results stay the same",
    ]);
  });

  it("applies a step's edits all together or not at all", () => {
    const loop = "DECLARE @id INT;\nUPDATE r SET n = 0;\nWHILE 1 = 0 BEGIN SET @id = 1; END";
    const rewrite = (lastBefore: string): ProposedStep => ({
      ...step("UPDATE r SET n = 0;", "UPDATE r SET n = (SELECT COUNT(*) FROM l);", { category: "set-based", title: "Set-based" }),
      edits: [
        { before: "UPDATE r SET n = 0;", after: "UPDATE r SET n = (SELECT COUNT(*) FROM l);" },
        { before: lastBefore, after: "" },
      ],
    });
    const broken = applySteps(loop, [{ ...rewrite("WHILE 9 = 9 BEGIN SET @id = 1; END"), index: 1 }], new Map());
    expect(broken.text).toBe(loop);
    expect(broken.outcomes[0].rejectedBecause).toBe("edit 2 of 2: the code to replace was not found in the file");

    const whole = applySteps(loop, [{ ...rewrite("WHILE 1 = 0 BEGIN SET @id = 1; END"), index: 1 }], new Map());
    expect(whole.outcomes[0]).toMatchObject({ status: "applied", lines: [2, 3] });
    expect(whole.text).toBe("DECLARE @id INT;\nUPDATE r SET n = (SELECT COUNT(*) FROM l);\n");
  });
});

describe("logic reference guard", () => {
  it("reads tables, qualified columns and string literals, ignoring comments, schemas and brackets", () => {
    const refs = logicReferences("SELECT o.[Status] FROM dbo.[Orders] o -- FROM Ghost\nWHERE o.Kind = 'IT''S' /* JOIN x */");
    expect([...refs].sort()).toEqual(["column:kind", "column:orders", "column:status", "string:IT'S", "table:orders"]);
  });

  it("lets a pure performance rewrite through, cursor removal included", () => {
    expect(droppedReferences("WHERE (SELECT COUNT(*) FROM s WHERE s.id = t.id) > 0", "WHERE EXISTS (SELECT 1 FROM s WHERE s.id = t.id)")).toEqual([]);
    expect(
      droppedReferences(
        "DECLARE cur CURSOR FOR SELECT OrderId FROM @R; FETCH NEXT FROM cur INTO @Id; UPDATE @R SET n = (SELECT COUNT(*) FROM L l WHERE l.OrderId = @Id);",
        "INSERT INTO @R SELECT o.OrderId, (SELECT COUNT(*) FROM L l WHERE l.OrderId = o.OrderId) FROM O o;",
      ),
    ).toEqual([]);
  });

  it("does not take a declared variable for a table", () => {
    const loop = "DECLARE r record; n bigint; BEGIN FOR r IN SELECT o.id FROM orders o LOOP SELECT count(*) INTO n FROM lines l WHERE l.id = r.id; END LOOP; END";
    const setBased = "BEGIN RETURN QUERY SELECT o.id, (SELECT count(*) FROM lines l WHERE l.id = o.id) FROM orders o; END";
    expect(droppedReferences(loop, setBased)).toEqual([]);
    // A table variable is still a table.
    expect([...logicReferences("DECLARE @R TABLE (id int); INSERT INTO @R SELECT 1;")]).toContain("table:@r");
  });

  it("catches a dropped filter column, table or status literal", () => {
    expect(droppedReferences("WHERE o.Status = 'PAID' AND o.Deleted = 0", "WHERE o.Status = 'PAID'")).toEqual(["column:deleted"]);
    expect(droppedReferences("FROM a JOIN b ON b.id = a.id", "FROM a")).toEqual(["column:id", "table:b"]);
    expect(droppedReferences("WHERE s = 'ACTIVE'", "WHERE s IS NOT NULL")).toEqual(["string:ACTIVE"]);
  });

  it("rejects a performance step that drops a reference, but not a requested logic change", () => {
    const sql = "SELECT id FROM t WHERE t.flag = 1 AND t.region = 'VN';";
    const drop = step("AND t.region = 'VN'", "", { category: "redundant-work", title: "Drop region" });
    expect(applySteps(sql, [{ ...drop, index: 1 }], new Map()).outcomes[0].rejectedBecause).toMatch(/column:region, string:VN/);
    const asked = { ...drop, category: "requested-logic" as const };
    expect(applySteps(sql, [{ ...asked, index: 1 }], new Map()).outcomes[0].status).toBe("applied");
  });
});

describe("rejectionOf", () => {
  const same = { verdict: "same-results" as const, reason: "ok" };
  it("applies a performance edit only when the check confirms the same results", () => {
    expect(rejectionOf(step("a", "b"), same, undefined)).toBeNull();
    expect(rejectionOf(step("a", "b"), { verdict: "unsure", reason: "depends on NULLs" }, undefined)).toMatch(/could not confirm/);
    expect(rejectionOf(step("a", "b"), undefined, undefined)).toMatch(/no verdict/);
    expect(rejectionOf(step("a", "b"), { verdict: "requested-change", reason: "x" }, "add a filter")).toMatch(/filed as a performance edit/);
  });

  it("allows a logic change only when the person asked for it and the check agrees it is what was asked", () => {
    const logic = step("a", "b", { category: "requested-logic" });
    const asked = { verdict: "requested-change" as const, reason: "matches" };
    expect(rejectionOf(logic, asked, undefined)).toMatch(/no change was requested/);
    expect(rejectionOf(logic, asked, "only active customers")).toBeNull();
    expect(rejectionOf(logic, { verdict: "changes-results", reason: "more than asked" }, "only active customers")).toMatch(/not what was requested/);
  });
});

describe("renderOptimizedFile", () => {
  it("heads the SQL with every step's query, before/after and reasons, the rejected ones and the suggestions", () => {
    const { text: sql, outcomes } = applySteps(
      ORIGINAL,
      [
        { ...step("WHERE (SELECT COUNT(*)  FROM s WHERE s.id = t.id) > 0;", "WHERE EXISTS (SELECT 1 FROM s WHERE s.id = t.id);"), index: 1, check: same() },
        { ...step("SELECT x", "SELECT y", { title: "Missing code" }), index: 2 },
      ],
      new Map(),
    );
    const text = renderOptimizedFile(
      { dialect: "sqlserver", steps: outcomes, warnings: ["SELECT * left: columns unknown."], indexSuggestions: ["CREATE INDEX IX_s_id ON s (id);"] },
      sql,
      "/x/q.sql",
      new Date("2026-10-16T00:00:00Z"),
    );
    expect(text).toContain("-- Optimized by aidev on 2026-10-16 from q.sql (SQL Server).");
    expect(text).toContain("-- Step 1: EXISTS instead of COUNT(*)\n--   Query: dbo.p — main SELECT");
    expect(text).toContain("--   Independent check: same-results — ok");
    expect(text).toContain("--   Before (line 4):\n--     WHERE (SELECT COUNT(*)  FROM s WHERE s.id = t.id) > 0;\n--   After:\n--     WHERE EXISTS (SELECT 1 FROM s WHERE s.id = t.id);");
    expect(text).toContain("--   - Step 2: Missing code — the code to replace was not found in the file");
    expect(text).toContain("--   CREATE INDEX IX_s_id ON s (id);");
    // The header is comments only; after it comes the SQL, exactly.
    const [header] = text.split("\n\nCREATE PROCEDURE");
    expect(header.split("\n").every((line) => line.startsWith("--"))).toBe(true);
    expect(text.endsWith(`\n\n${sql.trim()}\n`)).toBe(true);
  });
});

function same() {
  return { verdict: "same-results" as const, reason: "ok" };
}

describe("parseSqlOptimizeArgs", () => {
  it("reads the file, an explicit dialect and --overwrite", () => {
    expect(parseSqlOptimizeArgs(["--file", "a.sql", "--dialect", "MySQL", "--overwrite"])).toEqual({
      file: "a.sql",
      dialect: "mysql",
      overwrite: true,
    });
    expect(parseSqlOptimizeArgs(["--file", "a.sql", "--dialect", "auto"])).toEqual({ file: "a.sql", overwrite: false });
  });

  it("rejects a missing file or an unknown dialect", () => {
    expect(() => parseSqlOptimizeArgs([])).toThrow(/Usage: aidev sql-optimize/);
    expect(() => parseSqlOptimizeArgs(["--file", "a.sql", "--dialect", "oracle"])).toThrow(/Usage/);
  });
});

describe("SQL optimize progress", () => {
  it("lights the sql-optimize stage", () => {
    expect(stageOfProgress("SQL optimize: rewriting the code for lower load and run time")).toBe("sql-optimize");
  });
});
