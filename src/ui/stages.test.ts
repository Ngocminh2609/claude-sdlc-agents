import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isSetbackProgress, stageOfProgress, taskCountOfProgress } from "./stages.js";

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("stageOfProgress", () => {
  it("maps each message the pipeline actually emits", () => {
    expect(stageOfProgress("Reference inventory: scanning the reference repositories")).toBe("inventory");
    expect(stageOfProgress("Reference inventory: skipped (no reference repository)")).toBe("inventory");
    expect(stageOfProgress("Specs & Arch: attempt 1/3")).toBe("specs-arch");
    expect(stageOfProgress("Orchestrator review: approve")).toBe("review");
    expect(stageOfProgress("Orchestrator review: reject")).toBe("review");
    expect(stageOfProgress("Breaking approved design into tasks")).toBe("tasks");
    expect(stageOfProgress("4 task(s) to implement")).toBe("tasks");
    expect(stageOfProgress("Coding: task-2 (attempt 1/3)")).toBe("coding");
    expect(stageOfProgress("E2E/QA: running (attempt 1/3)")).toBe("e2e");
    expect(stageOfProgress("E2E/QA verdict: pass")).toBe("e2e");
  });

  it("maps the clone pipeline's messages too", () => {
    expect(stageOfProgress("Clone locate: searching the reference repositories")).toBe("locate");
    expect(stageOfProgress("Clone conventions: reading the target project")).toBe("conventions");
    expect(stageOfProgress("Clone mapping: 12 file(s) mapped, 2 uncertain")).toBe("mapping");
    expect(stageOfProgress("Clone port: BE:category (2/3)")).toBe("port");
    expect(stageOfProgress("Clone coverage: 11/12 file(s) present")).toBe("coverage");
    expect(stageOfProgress("Clone build: pass")).toBe("build");
  });

  it("returns null for anything it does not recognise", () => {
    expect(stageOfProgress("")).toBeNull();
    expect(stageOfProgress("npm warn deprecated")).toBeNull();
  });
});

describe("taskCountOfProgress", () => {
  it("reads the count only from the breakdown message", () => {
    expect(taskCountOfProgress("4 task(s) to implement")).toBe(4);
    expect(taskCountOfProgress("Coding: task-2 (attempt 1/3)")).toBeNull();
  });
});

describe("isSetbackProgress", () => {
  it("flags a rejected design, a failed E2E round and a lost inventory", () => {
    expect(isSetbackProgress("Orchestrator review: reject")).toBe(true);
    expect(isSetbackProgress("E2E/QA verdict: fail")).toBe(true);
    expect(isSetbackProgress("Reference inventory: unavailable — continuing without a file list")).toBe(
      true,
    );
    expect(isSetbackProgress("Orchestrator review: approve")).toBe(false);
    expect(isSetbackProgress("E2E/QA verdict: pass")).toBe(false);
    expect(isSetbackProgress("Reference inventory: 12 file(s) to cover")).toBe(false);
  });

  it("flags a clone that lost files or does not compile", () => {
    expect(isSetbackProgress("Clone coverage: 3 file(s) missing")).toBe(true);
    expect(isSetbackProgress("Clone build: fail")).toBe(true);
    expect(isSetbackProgress("Clone coverage: 12/12 file(s) present")).toBe(false);
    expect(isSetbackProgress("Clone build: pass")).toBe(false);
  });
});

describe("the wording this file depends on", () => {
  // stageOfProgress reads strings produced elsewhere, so a unit test of the
  // mapping alone would keep passing after a rename in pipeline.ts while the
  // UI quietly stopped advancing. Assert the source still emits them.
  it("is still the wording src/clone-pipeline.ts emits", async () => {
    const source = await readFile(path.join(srcDir, "clone-pipeline.ts"), "utf-8");

    for (const literal of [
      'onProgress("Clone locate: searching the reference repositories")',
      "Clone locate: ${inventory.files.length} source file(s) found",
      'onProgress("Clone conventions: reading the target project")',
      "Clone mapping: ${mapping.entries.length} file(s) mapped",
      "Clone port: ${group}",
      "Clone coverage: ${describeCoverage(coverage)}",
      "file(s) missing",
      "Clone build: ${build.ok ? \"pass\" : \"fail\"}",
    ]) {
      expect(source).toContain(literal);
    }
  });

  it("is still the wording src/pipeline.ts emits", async () => {
    const pipelineSource = await readFile(path.join(srcDir, "pipeline.ts"), "utf-8");

    for (const literal of [
      'onProgress("Reference inventory: scanning the reference repositories")',
      'onProgress("Reference inventory: skipped (no reference repository)")',
      "Reference inventory: unavailable — continuing without a file list",
      "onProgress(`Specs & Arch: attempt",
      "onProgress(`Orchestrator review: ${review.decision}`)",
      'onProgress("Breaking approved design into tasks")',
      "task(s) to implement`)",
      "onProgress(`Coding: ${task.id}",
      "onProgress(`E2E/QA: running",
      "onProgress(`E2E/QA verdict: ${e2e.verdict}`)",
    ]) {
      expect(pipelineSource).toContain(literal);
    }
  });
});
