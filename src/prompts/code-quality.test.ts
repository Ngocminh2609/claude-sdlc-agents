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
  "USE THE PROJECT'S OWN FORMATTER AND LINTER",
  "LEAVE NOTHING HALF-DONE",
  "KISS — PREFER THE SIMPLEST THING THAT MEETS THE REQUIREMENT",
  "YAGNI — BUILD WHAT WAS ASKED, NOT WHAT MIGHT BE NEEDED LATER",
  "KEEP THE PIPELINE GREEN, NOT JUST YOUR OWN COMPILE",
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

  it("forbids reformatting untouched code, which is what makes a diff unreviewable", () => {
    const flat = CODE_QUALITY_RULES.replace(/\s+/g, " ");
    expect(flat).toContain("Never reformat code you did not otherwise change");
    expect(flat).toContain("never run a formatter across the whole repo");
  });

  it("points at the target repo's own formatter instead of naming a style here", () => {
    const flat = CODE_QUALITY_RULES.replace(/\s+/g, " ");
    expect(flat).toContain(".editorconfig");
    expect(flat).toMatch(/Run that formatter and linter over the files you changed/);
    // A concrete house style would be wrong for every repo that chose otherwise.
    expect(CODE_QUALITY_RULES).not.toMatch(/\b(2|4) spaces\b/);
    expect(CODE_QUALITY_RULES).not.toMatch(/\b(80|100|120) (columns|characters)\b/);
  });

  it("names all three golden principles explicitly: DRY, KISS, YAGNI", () => {
    expect(CODE_QUALITY_RULES).toMatch(/\bDRY\b/);
    expect(CODE_QUALITY_RULES).toMatch(/\bKISS\b/);
    expect(CODE_QUALITY_RULES).toMatch(/\bYAGNI\b/);
  });

  it("forbids speculative flexibility built before a second real use exists", () => {
    const flat = CODE_QUALITY_RULES.replace(/\s+/g, " ");
    expect(flat).toContain("Do not add error handling, retries, or a fallback path for a scenario the");
    expect(flat).toContain("configurable framework in anticipation");
  });

  it("mirrors the pipeline's actual build instead of a bare local compile check", () => {
    const flat = CODE_QUALITY_RULES.replace(/\s+/g, " ");
    expect(flat).toContain(".gitlab-ci.yml");
    expect(flat).toContain("An unregistered unit is invisible to the build and deploy graph");
    expect(flat).toMatch(/lockfile regenerated and committed/);
  });

  it("warns that a type-checker is not the build, since bundlers strip types without validating them", () => {
    const flat = CODE_QUALITY_RULES.replace(/\s+/g, " ");
    expect(flat).toContain("A type-checker is not a substitute for this");
    expect(flat).toMatch(/esbuild, webpack, vite/);
  });

  it("warns that a hand-written stand-in for generated code has unverified names and a fragile hand-patch", () => {
    const flat = CODE_QUALITY_RULES.replace(/\s+/g, " ");
    expect(flat).toContain("do not trust a reasoned guess at its exact names");
    expect(flat).toContain("is only as durable as the next regeneration");
    expect(flat).toMatch(/MULTIPART_FORM_DATA_VALUE/);
  });

  it("reaches the coding stage's system prompt", async () => {
    runTextQuery.mockClear();
    runTextQuery.mockResolvedValue({ ok: true, text: "done" });

    await runCoding({ spec, task, approvedProposal: "a design", completedTasks: [] });

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
    await runCoding({ spec, task, approvedProposal: "a design", completedTasks: [] });
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
