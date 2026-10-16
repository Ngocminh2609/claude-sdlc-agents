import { describe, expect, it } from "vitest";
import { CHUNK_MAX_CHARS, CHUNK_TARGET_CHARS, splitSqlChunks } from "./sql-chunks.js";

const proc = (name: string, bodyLines: number) =>
  [
    `-- ${name}: report`,
    `CREATE OR ALTER PROCEDURE dbo.${name}`,
    "    @Year INT",
    "AS",
    "BEGIN",
    "    DECLARE @Total INT;",
    ...Array.from({ length: bodyLines }, (_, i) => `    SELECT @Total = COUNT(*) FROM dbo.Orders o WHERE o.Id > ${i};`),
    "END",
    "GO",
    "",
  ].join("\r\n");

const reassembled = (text: string) => splitSqlChunks(text).map((chunk) => text.slice(chunk.start, chunk.end)).join("");

describe("splitSqlChunks", () => {
  it("keeps a file under the target in one part", () => {
    const text = proc("usp_A", 10);
    expect(splitSqlChunks(text)).toEqual([{ start: 0, end: text.length, label: "whole file" }]);
  });

  it("cuts a large file at routine boundaries, merging small routines, and reassembles it byte for byte", () => {
    const text = Array.from({ length: 60 }, (_, i) => proc(`usp_${i}`, 30)).join("");
    expect(text.length).toBeGreaterThan(CHUNK_TARGET_CHARS * 2);
    const chunks = splitSqlChunks(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(reassembled(text)).toBe(text);
    for (const chunk of chunks) {
      expect(chunk.end - chunk.start).toBeLessThanOrEqual(CHUNK_TARGET_CHARS);
      // Each part starts at a routine's comment line, never mid-procedure.
      expect(text.slice(chunk.start, chunk.end)).toMatch(/^-- usp_\d+: report\r\nCREATE OR ALTER PROCEDURE/);
      expect(chunk.context).toBeUndefined();
    }
    expect(chunks[0].label).toMatch(/^dbo\.usp_0, dbo\.usp_1, dbo\.usp_2 \+\d+$/);
  });

  it("cuts one huge procedure at statement ends and gives later pieces its header and declarations", () => {
    const text = proc("usp_Huge", 6000);
    expect(text.length).toBeGreaterThan(CHUNK_MAX_CHARS * 2);
    const chunks = splitSqlChunks(text);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(reassembled(text)).toBe(text);
    for (const [i, chunk] of chunks.entries()) {
      const piece = text.slice(chunk.start, chunk.end);
      expect(piece.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
      if (i < chunks.length - 1) expect(piece).toMatch(/;\r\n$/); // ends after a whole statement
      expect(chunk.label).toContain(`dbo.usp_Huge (piece ${i + 1}, lines `);
      if (i === 0) expect(chunk.context).toBeUndefined();
      else {
        expect(chunk.context).toContain("CREATE OR ALTER PROCEDURE dbo.usp_Huge");
        expect(chunk.context).toContain("DECLARE @Total INT;");
      }
    }
  });
});
