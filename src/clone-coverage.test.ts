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

describe("checkCoverage with separate BE/FE folders", () => {
  let be: string;
  let fe: string;

  beforeAll(async () => {
    be = path.join(project, "be-root");
    fe = path.join(project, "fe-root");
    await mkdir(path.join(be, "src"), { recursive: true });
    await mkdir(path.join(fe, "src"), { recursive: true });
    await writeFile(path.join(be, "src", "Ctl.java"), "x", "utf-8");
    await writeFile(path.join(fe, "src", "page.tsx"), "x", "utf-8");
  });

  it("checks each file in the folder its root names", () => {
    const roots = [
      { role: "be" as const, path: be },
      { role: "fe" as const, path: fe },
    ];
    const result = checkCoverage(
      {
        entries: [
          { source: "a", target: "src/Ctl.java", root: "be", group: "BE", changes: "" },
          { source: "b", target: "src/page.tsx", root: "fe", group: "FE", changes: "" },
          // Right file name, wrong folder: FE has no Ctl.java, so it is missing.
          { source: "c", target: "src/Ctl.java", root: "fe", group: "FE", changes: "" },
        ],
        notes: "",
      },
      roots,
    );

    expect(result.present).toEqual(["src/Ctl.java", "src/page.tsx"]);
    expect(result.missing).toEqual(["src/Ctl.java"]);
  });
});

describe("checkCoverage with declared deviations", () => {
  const promised = () => mapping("modules/category/Merged.java", "modules/category/Api.ts", "modules/category/Gone.java");

  it("counts a merge as covered only when the file it was merged into exists", () => {
    const result = checkCoverage(promised(), project, [
      { target: "modules/category/Merged.java", kind: "merged", coveredBy: "modules/category/Ported.java", reason: "one class" },
      { target: "modules/category/Gone.java", kind: "merged", coveredBy: "modules/category/Nowhere.java", reason: "claimed" },
    ]);

    expect(result.merged?.map((d) => d.target)).toEqual(["modules/category/Merged.java"]);
    expect(result.missing).toEqual(["modules/category/Api.ts", "modules/category/Gone.java"]);
  });

  it("still reports a not-needed file as missing — that claim is for a person to check", () => {
    const result = checkCoverage(promised(), project, [
      { target: "modules/category/Gone.java", kind: "not-needed", reason: "unused" },
    ]);

    expect(result.missing).toEqual([
      "modules/category/Merged.java",
      "modules/category/Api.ts",
      "modules/category/Gone.java",
    ]);
  });

  it("matches a deviation named by its absolute path", () => {
    const result = checkCoverage(promised(), project, [
      {
        target: path.join(project, "modules", "category", "Merged.java"),
        kind: "merged",
        coveredBy: path.join(project, "modules", "category", "Ported.java"),
        reason: "one class",
      },
    ]);

    expect(result.merged).toHaveLength(1);
  });

  it("says how many were merged into other files", () => {
    expect(
      describeCoverage({
        present: ["a"],
        missing: ["c"],
        merged: [{ target: "b", kind: "merged", coveredBy: "a", reason: "" }],
      }),
    ).toBe("1/3 file(s) present (1 merged into other files)");
  });
});

describe("describeCoverage", () => {
  it("reads as a fraction of what was promised", () => {
    expect(describeCoverage({ present: ["a", "b"], missing: ["c"] })).toBe("2/3 file(s) present");
    expect(describeCoverage({ present: [], missing: [] })).toBe("0/0 file(s) present");
  });
});

describe("checkCoverage with notPorted entries", () => {
  // Reproduces a defect observed for real: Clone Mapping wrote non-path text
  // ("(none — not ported)", "(none found)") into `target` for source files it
  // decided not to port, and checkCoverage — having no way to tell those apart
  // from a genuinely forgotten file — correctly-but-wrongly counted every one
  // of them as missing. A clone that ported everything it meant to still came
  // back "incomplete".
  const notPorted = (source: string, changes = "duplicate variant"): ReturnType<typeof mapping>["entries"][number] => ({
    source,
    target: "",
    group: "excluded",
    changes,
    notPorted: true,
  });

  it("never checks a notPorted entry against the filesystem, and does not count it missing", () => {
    const result = checkCoverage(
      { entries: [...mapping("modules/category/Ported.java").entries, notPorted("Sibling.java")], notes: "" },
      project,
    );

    expect(result.present).toEqual(["modules/category/Ported.java"]);
    expect(result.missing).toEqual([]);
  });

  it("reports it separately, for a person to check — not silently dropped", () => {
    const entry = notPorted("Sibling.java", "read-only NienGiam variant, superseded by the Cong entry");
    const result = checkCoverage({ entries: [entry], notes: "" }, project);

    expect(result.excluded).toEqual([entry]);
  });

  it("keeps notPorted out of the present/missing fraction entirely", () => {
    const result = checkCoverage(
      {
        entries: [...mapping("modules/category/Ported.java", "modules/category/Missing.java").entries, notPorted("A"), notPorted("B")],
        notes: "",
      },
      project,
    );

    // 1 present, 1 missing, 2 notPorted — the fraction must read 1/2, not 1/4.
    expect(describeCoverage(result)).toBe("1/2 file(s) present (2 intentionally not ported)");
  });
});
