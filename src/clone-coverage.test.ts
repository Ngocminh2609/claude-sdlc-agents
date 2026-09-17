import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkCoverage, describeCoverage } from "./clone-coverage.js";
import type { CloneMapping } from "./types.js";

let project: string;

function mapping(...targets: string[]): CloneMapping {
  return {
    entries: targets.map((target, index) => ({
      source: `src/${index}.java`,
      target,
      group: "BE",
      changes: "package rename",
    })),
    notes: "",
  };
}

beforeAll(async () => {
  project = await mkdtemp(path.join(tmpdir(), "aidev-cov-"));
  await mkdir(path.join(project, "modules", "category"), { recursive: true });
  await writeFile(path.join(project, "modules", "category", "Ported.java"), "x", "utf-8");
});

afterAll(async () => {
  await rm(project, { recursive: true, force: true });
});

describe("checkCoverage", () => {
  it("counts a file that was actually written as present", () => {
    const result = checkCoverage(mapping("modules/category/Ported.java"), project);

    expect(result.present).toEqual(["modules/category/Ported.java"]);
    expect(result.missing).toEqual([]);
  });

  it("names every promised file that is not on disk", () => {
    const result = checkCoverage(
      mapping("modules/category/Ported.java", "modules/category/Missing.java"),
      project,
    );

    expect(result.present).toEqual(["modules/category/Ported.java"]);
    expect(result.missing).toEqual(["modules/category/Missing.java"]);
  });

  it("does not accept a directory as the ported file", () => {
    const result = checkCoverage(mapping("modules/category"), project);

    expect(result.missing).toEqual(["modules/category"]);
  });

  it("resolves targets against the project, not the process working directory", () => {
    const result = checkCoverage(mapping("modules/category/Ported.java"), project);
    const elsewhere = checkCoverage(mapping("modules/category/Ported.java"), tmpdir());

    expect(result.missing).toEqual([]);
    expect(elsewhere.missing).toHaveLength(1);
  });
});

describe("describeCoverage", () => {
  it("reads as a fraction of what was promised", () => {
    expect(describeCoverage({ present: ["a", "b"], missing: ["c"] })).toBe("2/3 file(s) present");
    expect(describeCoverage({ present: [], missing: [] })).toBe("0/0 file(s) present");
  });
});
