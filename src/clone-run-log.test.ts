import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { CloneRunLogger } from "./run-log.js";
import type { CloneInput, CloneMapping } from "./types.js";

const clone: CloneInput = {
  what: "Danh mục nghề nghiệp",
  projectPath: "/tmp/CSDL-VIMO",
  referencePaths: ["/tmp/TKDT"],
};

const mapping: CloneMapping = {
  entries: [
    {
      source: "be/OccupationController.java",
      target: "BE-CSDL/modules/category/OccupationController.java",
      group: "BE:category",
      changes: "package com.fpt -> vn.gov.tctk",
    },
    {
      source: "fe/occupations.tsx",
      target: "FE-CSDL/src/features/occupations.tsx",
      group: "FE",
      changes: "route path",
      uncertain: true,
    },
  ],
  notes: "placed server code under modules/category",
};

let writtenDir: string | undefined;

afterEach(async () => {
  if (writtenDir) {
    await rm(writtenDir, { recursive: true, force: true });
    writtenDir = undefined;
  }
});

async function readReport(dir: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(`${dir}/report.md`, "utf-8");
}

describe("CloneRunLogger", () => {
  it("writes the mapping as a checklist, ticked against what is actually on disk", async () => {
    const logger = new CloneRunLogger(clone);
    logger.recordCloneMapping(mapping);
    logger.recordCloneCoverage({
      present: ["BE-CSDL/modules/category/OccupationController.java"],
      missing: ["FE-CSDL/src/features/occupations.tsx"],
    });
    logger.finish("incomplete", "1/2 file(s) present.");

    writtenDir = await logger.write();
    const report = await readReport(writtenDir);

    expect(report).toContain("- [x] **BE:category** `be/OccupationController.java`");
    expect(report).toContain("- [ ] **FE** `fe/occupations.tsx`");
    expect(report).toContain("_(uncertain)_");
    expect(report).toContain("package com.fpt -> vn.gov.tctk");
    expect(report).toContain("placed server code under modules/category");
  });

  it("puts the missing files where a reader looks first", async () => {
    const logger = new CloneRunLogger(clone);
    logger.recordCloneMapping(mapping);
    logger.recordCloneCoverage({ present: [], missing: ["FE-CSDL/src/features/occupations.tsx"] });
    logger.finish("incomplete", "0/2 file(s) present.");

    writtenDir = await logger.write();
    const report = await readReport(writtenDir);

    expect(report.indexOf("## Coverage")).toBeLessThan(report.indexOf("## File mapping"));
    expect(report).toContain("**Missing:**");
  });

  it("records a failing build with its real errors, not a summary of them", async () => {
    const logger = new CloneRunLogger(clone);
    logger.recordCloneMapping(mapping);
    logger.recordCloneBuild({
      ok: false,
      command: "mvn -pl modules/category test-compile",
      summary: "1 error",
      errors: ["OccupationController.java:12 cannot find symbol"],
    });
    logger.finish("incomplete", "build failed");

    writtenDir = await logger.write();
    const report = await readReport(writtenDir);

    expect(report).toContain("mvn -pl modules/category test-compile");
    expect(report).toContain("cannot find symbol");
  });

  it("names the run so it sorts alongside feature runs in runs/", async () => {
    const logger = new CloneRunLogger(clone);
    logger.finish("done", "ok");

    writtenDir = await logger.write();

    // <iso-timestamp>-<project>-clone-<slug>. Vietnamese tone marks decompose
    // and drop out, so the folder name stays readable and path-safe.
    expect(writtenDir).toMatch(/\d{4}-\d{2}-\d{2}T[\d-]+Z-CSDL-VIMO-clone-Danh-muc-nghe-nghiep$/);
  });
});
