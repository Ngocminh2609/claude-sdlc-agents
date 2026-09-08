import { describe, expect, it, vi } from "vitest";
import { CODE_QUALITY_RULES } from "./code-quality.js";
import type { SpecInput, TaskItem } from "../types.js";

const runTextQuery = vi.fn();
vi.mock("../sdk-helpers.js", () => ({ runTextQuery }));

const { runCoding } = await import("../stages/coding.js");
const { runSpecsArch } = await import("../stages/specs-arch.js");

const spec: SpecInput = { specMarkdown: "build a widget", projectPath: "/tmp/project" };
const task: TaskItem = { id: "task-1", description: "implement the widget endpoint" };

/** A marker line from each section, so a silently gutted rule set fails the test. */
const SECTION_MARKERS = [
  "REUSE BEFORE YOU WRITE",
  "REMOVE DUPLICATION YOU CREATE OR TOUCH",
  "KEEP COUPLED DECISIONS ADJACENT",
  "NEVER INTERPOLATE CALLER INPUT INTO A COMMAND OR QUERY",
  "MATCH THE CODE AROUND YOU",
  "LEAVE NOTHING HALF-DONE",
];

describe("CODE_QUALITY_RULES", () => {
  it("keeps every section it promises", () => {
    for (const marker of SECTION_MARKERS) {
      expect(CODE_QUALITY_RULES).toContain(marker);
    }
  });

  it("states the second-occurrence threshold rather than extracting eagerly", () => {
    expect(CODE_QUALITY_RULES).toContain("Extract on the second real occurrence");
  });

  it("reaches the coding stage's system prompt", async () => {
    runTextQuery.mockClear();
    runTextQuery.mockResolvedValue({ ok: true, text: "done" });

    await runCoding(spec, task, undefined);

    const [, options] = runTextQuery.mock.calls[0];
    expect(options.systemPrompt).toContain(CODE_QUALITY_RULES);
  });

  it("reaches the specs & arch stage's system prompt", async () => {
    runTextQuery.mockClear();
    runTextQuery.mockResolvedValue({ ok: true, text: "proposal" });

    await runSpecsArch(spec, null, undefined);

    const [, options] = runTextQuery.mock.calls[0];
    expect(options.systemPrompt).toContain(CODE_QUALITY_RULES);
  });

  it("is defined once and shared, not pasted into each stage", async () => {
    runTextQuery.mockClear();
    runTextQuery.mockResolvedValue({ ok: true, text: "done" });
    await runCoding(spec, task, undefined);
    const [, codingOptions] = runTextQuery.mock.calls[0];

    runTextQuery.mockClear();
    runTextQuery.mockResolvedValue({ ok: true, text: "proposal" });
    await runSpecsArch(spec, null, undefined);
    const [, specsOptions] = runTextQuery.mock.calls[0];

    // Both stages must carry byte-identical rule text; a divergent copy is the very
    // duplication these rules forbid.
    const extract = (prompt: string) => prompt.slice(prompt.indexOf(SECTION_MARKERS[0]));
    expect(extract(codingOptions.systemPrompt)).toEqual(extract(specsOptions.systemPrompt));
  });
});
