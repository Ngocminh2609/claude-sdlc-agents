import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { RunLogger } from "./run-log.js";
import type { SpecInput } from "./types.js";

const spec: SpecInput = {
  specMarkdown: "build a widget",
  projectPath: "/tmp/some-project",
  dbInfo: { kind: "connection", value: "postgres://user:super-secret-password@host/db" },
};

let writtenDir: string | undefined;

afterEach(async () => {
  if (writtenDir) {
    await rm(writtenDir, { recursive: true, force: true });
    writtenDir = undefined;
  }
});

describe("RunLogger", () => {
  it("writes log.json and report.md, and never persists the raw db connection value", async () => {
    const logger = new RunLogger(spec, "/tmp/specs/my-feature.md");
    logger.recordSpecsArch(1, "a proposal");
    logger.recordReview(1, { decision: "approve", feedback: "looks good" });
    logger.recordTaskBreakdown([{ id: "task-1", description: "do the thing" }]);
    logger.recordCoding(1, "task-1", "implemented");
    logger.recordE2e(1, { verdict: "pass", summary: "all good" });
    logger.finish("done", "E2E/QA passed.");

    writtenDir = await logger.write();

    const { readFile } = await import("node:fs/promises");
    const json = JSON.parse(await readFile(`${writtenDir}/log.json`, "utf-8"));
    const markdown = await readFile(`${writtenDir}/report.md`, "utf-8");

    expect(json.dbInfoKind ?? json.spec?.dbInfoKind).toBe("connection");
    expect(JSON.stringify(json)).not.toContain("super-secret-password");
    expect(markdown).not.toContain("super-secret-password");

    expect(json.finalStatus).toBe("done");
    expect(json.specsArch[0].proposal).toBe("a proposal");
    expect(markdown).toContain("a proposal");
  });

  it("writes the reference inventory into the report, as the checklist to diff against", async () => {
    const logger = new RunLogger(
      { ...spec, referencePaths: ["/tmp/sample-app"] },
      "/tmp/specs/my-feature.md",
    );
    logger.recordReferenceInventory({
      files: [{ path: "src/units/UnitController.java", role: "REST endpoints" }],
      notes: "skipped target/",
    });
    logger.finish("done", "E2E/QA passed.");

    writtenDir = await logger.write();

    const { readFile } = await import("node:fs/promises");
    const markdown = await readFile(`${writtenDir}/report.md`, "utf-8");

    expect(markdown).toContain("/tmp/sample-app");
    expect(markdown).toContain("src/units/UnitController.java");
    expect(markdown).toContain("REST endpoints");
    expect(markdown).toContain("skipped target/");
  });

  it("says so in the report when a reference run produced no inventory", async () => {
    const logger = new RunLogger(
      { ...spec, referencePaths: ["/tmp/sample-app"] },
      "/tmp/specs/my-feature.md",
    );
    logger.recordReferenceInventory(null);
    logger.finish("done", "E2E/QA passed.");

    writtenDir = await logger.write();

    const { readFile } = await import("node:fs/promises");
    const markdown = await readFile(`${writtenDir}/report.md`, "utf-8");

    expect(markdown).toContain("no file list for this run");
  });
});
