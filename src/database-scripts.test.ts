import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyNewScripts,
  databasePromptSection,
  snapshotScripts,
  type SqlScriptState,
} from "./database-scripts.js";
import type { SqlRunner } from "./database.js";

let dir: string;
let ran: string[];
let failOn: string | null;

const runner: SqlRunner = {
  async runScript(sql) {
    if (failOn && sql.includes(failOn)) throw new Error(`relation "${failOn}" already exists`);
    ran.push(sql);
  },
  async close() {},
};

const write = async (file: string, sql: string) => {
  await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await writeFile(path.join(dir, file), sql, "utf-8");
};

const apply = (state: SqlScriptState, progress: string[] = []) =>
  applyNewScripts({ dir, state, runner, onProgress: (m) => progress.push(m), save: async () => {} });

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "aidev-sql-"));
  ran = [];
  failOn = null;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("applyNewScripts", () => {
  it("runs only scripts that were not there when the run started, in numeric file-name order", async () => {
    await write("01-old-schema.sql", "CREATE TABLE old_one(id int);");
    const state: SqlScriptState = { baseline: await snapshotScripts(dir), applied: {} };

    await write("10-seed.sql", "INSERT INTO unit VALUES (1);");
    await write("2-unit-schema.sql", "CREATE TABLE unit(id int);");
    await write("unit/03-index.sql", "CREATE INDEX ix ON unit(id);");

    const applied = await apply(state);

    // Ordered by full relative path, numbers compared as numbers: 2 before 10, sub-folders after.
    expect(applied).toEqual(["2-unit-schema.sql", "10-seed.sql", "unit/03-index.sql"]);
    expect(ran).toEqual(["CREATE TABLE unit(id int);", "INSERT INTO unit VALUES (1);", "CREATE INDEX ix ON unit(id);"]);
    expect(Object.keys(state.applied)).toHaveLength(3);
  });

  it("does not run a script twice, and never runs a rollback script", async () => {
    const state: SqlScriptState = { baseline: {}, applied: {} };
    await write("01-unit-schema.sql", "CREATE TABLE unit(id int);");
    await write("99-rollback-unit.sql", "DROP TABLE unit;");

    await apply(state);
    await apply(state);

    expect(ran).toEqual(["CREATE TABLE unit(id int);"]);
  });

  it("stops when a script that already ran was edited, instead of running it again", async () => {
    const state: SqlScriptState = { baseline: {}, applied: {} };
    await write("01-unit-schema.sql", "CREATE TABLE unit(id int);");
    await apply(state);

    await write("01-unit-schema.sql", "CREATE TABLE unit(id int, code text);");
    await expect(apply(state)).rejects.toThrow(/01-unit-schema\.sql changed after it was applied/);
  });

  it("refuses the whole batch when one new script is destructive, before running any", async () => {
    const state: SqlScriptState = { baseline: {}, applied: {} };
    await write("01-unit-schema.sql", "CREATE TABLE unit(id int);");
    await write("02-cleanup.sql", "TRUNCATE unit;");

    await expect(apply(state)).rejects.toThrow(/02-cleanup\.sql was not run — it contains a destructive statement/);
    expect(ran).toEqual([]);
  });

  it("reports the database's own error and keeps the scripts before it applied", async () => {
    const state: SqlScriptState = { baseline: {}, applied: {} };
    await write("01-a.sql", "CREATE TABLE a(id int);");
    await write("02-b.sql", "CREATE TABLE b(id int);");
    failOn = "b(id";

    await expect(apply(state)).rejects.toThrow(/02-b\.sql failed and was rolled back: relation "b\(id" already exists/);
    expect(Object.keys(state.applied)).toEqual(["01-a.sql"]);
  });
});

describe("databasePromptSection", () => {
  it("is empty without a database, and names engine and folder with one", () => {
    expect(databasePromptSection(undefined, "code")).toEqual([]);
    const text = databasePromptSection(
      { dialect: "sqlserver", description: "SQL Server at sql01/TKDT", scriptsDir: "D:/app/SQL" },
      "code",
    ).join("\n");
    expect(text).toContain("SQL Server syntax");
    expect(text).toContain("D:/app/SQL");
    expect(text).toContain("rollback");
  });
});
