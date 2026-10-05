import { describe, expect, it } from "vitest";
import { findDestructiveStatement, splitGoBatches, topLevelStatements } from "./sql-safety.js";

describe("findDestructiveStatement", () => {
  it("lets a plain create-and-insert script through", () => {
    const sql = `
      CREATE TABLE IF NOT EXISTS c_unit (
        id bigserial PRIMARY KEY,
        parent_id bigint REFERENCES c_unit(id) ON DELETE CASCADE,
        code varchar(50) NOT NULL UNIQUE
      );
      CREATE INDEX ix_unit_code ON c_unit(code);
      INSERT INTO c_unit(code) VALUES ('KG');
      ALTER TABLE c_unit ALTER COLUMN code DROP NOT NULL;
      GRANT SELECT, INSERT, DELETE ON c_unit TO app_user;`;
    expect(findDestructiveStatement(sql)).toBeNull();
  });

  it("refuses DROP, TRUNCATE and DELETE at the top level", () => {
    expect(findDestructiveStatement("CREATE TABLE a(id int);\nDROP TABLE b;")).toMatch(/^DROP TABLE b/);
    expect(findDestructiveStatement("TRUNCATE c_unit;")).toMatch(/^TRUNCATE/);
    expect(findDestructiveStatement("DELETE FROM c_unit WHERE id = 1;")).toMatch(/^DELETE/);
    expect(findDestructiveStatement("ALTER TABLE c_unit DROP COLUMN code;")).toMatch(/DROP COLUMN/);
  });

  it("refuses a SQL Server guarded drop, which starts with IF rather than DROP", () => {
    const sql = "IF OBJECT_ID('dbo.c_unit') IS NOT NULL DROP TABLE dbo.c_unit;\nGO\nCREATE TABLE dbo.c_unit(id int);";
    expect(findDestructiveStatement(sql)).toMatch(/DROP TABLE/);
  });

  it("allows a routine whose body deletes rows — defining it deletes nothing", () => {
    const postgres = `
      CREATE OR REPLACE FUNCTION remove_unit(p_id bigint) RETURNS void AS $$
      BEGIN
        DELETE FROM c_unit WHERE id = p_id;
      END;
      $$ LANGUAGE plpgsql;`;
    const sqlServer = `
      CREATE PROCEDURE dbo.usp_RemoveUnit @id int AS
      BEGIN
        DELETE FROM dbo.c_unit WHERE id = @id;
      END
      GO`;
    const mysql = `
      CREATE PROCEDURE remove_unit(IN p_id INT)
      BEGIN
        IF p_id > 0 THEN
          DELETE FROM c_unit WHERE id = p_id;
        END IF;
      END;`;
    expect(findDestructiveStatement(postgres)).toBeNull();
    expect(findDestructiveStatement(sqlServer)).toBeNull();
    expect(findDestructiveStatement(mysql)).toBeNull();
  });

  it("ignores the words inside comments and string literals", () => {
    const sql = "-- DROP TABLE old;\n/* TRUNCATE x; */\nINSERT INTO note(text) VALUES ('please DELETE me; it''s fine');";
    expect(findDestructiveStatement(sql)).toBeNull();
  });

  it("still catches a deletion after a transaction BEGIN;", () => {
    expect(findDestructiveStatement("BEGIN;\nDELETE FROM c_unit;\nCOMMIT;")).toMatch(/^DELETE/);
  });
});

describe("topLevelStatements", () => {
  it("splits on semicolons and GO lines, not inside BEGIN…END or CASE…END", () => {
    const statements = topLevelStatements(
      "CREATE VIEW v AS SELECT CASE WHEN a > 0 THEN 1 ELSE 0 END AS b FROM t;\nGO\nSELECT 1;",
    );
    expect(statements).toHaveLength(2);
  });
});

describe("splitGoBatches", () => {
  it("cuts a SQL Server script at GO lines only", () => {
    expect(splitGoBatches("CREATE TABLE a(id int)\nGO\nINSERT INTO a VALUES (1) -- GOOD\ngo\n")).toEqual([
      "CREATE TABLE a(id int)",
      "INSERT INTO a VALUES (1) -- GOOD",
    ]);
  });
});
