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
  it("saves the log after every step when asked, so a killed run still shows what it finished", async () => {
    const { readFile } = await import("node:fs/promises");
    const logger = new RunLogger(spec, "/tmp/specs/saved-as-it-goes.md", { saveAsItGoes: true });
    logger.recordTaskBreakdown([{ id: "task-1", description: "do the thing" }]);
    logger.recordCoding(1, "task-1", "implemented");
    // No finish(): this is the state a killed run leaves behind.
    writtenDir = await logger.write();

    const saved = JSON.parse(await readFile((await import("node:path")).join(writtenDir, "log.json"), "utf-8"));
    expect(saved.finalStatus).toBe("in-progress");
    expect(saved.coding.map((entry: { taskId: string }) => entry.taskId)).toEqual(["task-1"]);
    expect(JSON.stringify(saved)).not.toContain("super-secret-password");
  });

  it("keeps each build check and loop-guard intervention, so a run can be audited afterwards", async () => {
    const logger = new RunLogger(spec, "/tmp/specs/activity.md");
    logger.recordStepActivity({ step: "gate:baseline", phase: "end", ok: true });
    logger.recordStepActivity({ step: "gate:task-1", phase: "end", ok: false });
    logger.recordStepActivity({ step: "coding:task-1", phase: "turn", turns: 3, maxTurns: 60, note: "repeat" });
    logger.recordStepActivity({ step: "e2e", phase: "turn", turns: 48, maxTurns: 60, note: "soft-cap" });
    logger.recordStepActivity({ step: "coding:task-1", phase: "turn", turns: 4, maxTurns: 60 });
    logger.finish("errored", "stopped");
    writtenDir = await logger.write();

    const { readFile } = await import("node:fs/promises");
    const json = JSON.parse(await readFile(`${writtenDir}/log.json`, "utf-8"));
    const markdown = await readFile(`${writtenDir}/report.md`, "utf-8");
    expect(json.buildChecks.map((check: { step: string; ok: boolean }) => [check.step, check.ok])).toEqual([
      ["gate:baseline", true],
      ["gate:task-1", false],
    ]);
    expect(json.loopGuard).toEqual({
      "coding:task-1": { repeat: 1, blocked: 0, softCap: 0 },
      e2e: { repeat: 0, blocked: 0, softCap: 1 },
    });
    expect(markdown).toContain("- gate:task-1: **fail**");
    expect(markdown).toContain("- e2e: 0 repeat warning(s), 0 refused call(s), 1 wrap-up nudge(s)");
  });

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

  it("writes the project context into the report", async () => {
    const logger = new RunLogger(spec, "/tmp/specs/my-feature.md");
    logger.recordProjectContext({
      conventions: "kebab-case files, tests alongside source",
      relevantFiles: [{ path: "src/widget-base.ts", role: "base class to extend" }],
      notes: "skipped dist/",
    });
    logger.finish("done", "E2E/QA passed.");

    writtenDir = await logger.write();

    const { readFile } = await import("node:fs/promises");
    const markdown = await readFile(`${writtenDir}/report.md`, "utf-8");

    expect(markdown).toContain("kebab-case files");
    expect(markdown).toContain("src/widget-base.ts");
    expect(markdown).toContain("skipped dist/");
  });

  it("says in the report when a run continued a stopped one, and what it reused", async () => {
    const logger = new RunLogger(spec, "/tmp/specs/my-feature.md");
    logger.recordResume("2026-09-24T01:00:00Z", ["task-1", "task-2"]);
    logger.finish("done", "E2E/QA passed.");

    writtenDir = await logger.write();

    const { readFile } = await import("node:fs/promises");
    const markdown = await readFile(`${writtenDir}/report.md`, "utf-8");

    expect(markdown).toContain("Resumed run");
    expect(markdown).toContain("2026-09-24T01:00:00Z");
    expect(markdown).toContain("task-1, task-2");
  });

  it("says so in the report when the project context scan produced nothing", async () => {
    const logger = new RunLogger(spec, "/tmp/specs/my-feature.md");
    logger.recordProjectContext(null);
    logger.finish("done", "E2E/QA passed.");

    writtenDir = await logger.write();

    const { readFile } = await import("node:fs/promises");
    const markdown = await readFile(`${writtenDir}/report.md`, "utf-8");

    expect(markdown).toContain("explored the target project on its own");
  });
});
