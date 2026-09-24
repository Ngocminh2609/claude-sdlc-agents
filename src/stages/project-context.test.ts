import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpecInput } from "../types.js";

const runStructuredQuery = vi.fn();
vi.mock("../sdk-helpers.js", () => ({ runStructuredQuery }));

const { inventoryProjectContext, projectContextPromptSection } = await import("./project-context.js");

const spec: SpecInput = {
  specMarkdown: "add a formatDuration utility",
  projectPath: "/tmp/project",
};

beforeEach(() => {
  runStructuredQuery.mockClear();
});

describe("inventoryProjectContext", () => {
  it("reads the target project only — no reference dirs, no write tools", async () => {
    runStructuredQuery.mockResolvedValue({
      ok: true,
      data: { conventions: "src/ holds everything", relevantFiles: [], notes: "" },
    });

    await inventoryProjectContext(spec);

    const [prompt, options] = runStructuredQuery.mock.calls[0];
    expect(options.additionalDirectories).toBeUndefined();
    expect(options.allowedTools).toEqual(["Read", "Glob", "Grep"]);
    expect(options.allowedTools).not.toContain("Write");
    expect(options.allowedTools).not.toContain("Edit");
    expect(options.allowedTools).not.toContain("Bash");
    expect(prompt).toContain("add a formatDuration utility");
  });

  it("returns the conventions and relevant files the scan produced", async () => {
    runStructuredQuery.mockResolvedValue({
      ok: true,
      data: {
        conventions: "kebab-case files, tests alongside source",
        relevantFiles: [{ path: "src/duration.ts", role: "existing time-formatting helper" }],
        notes: "skipped node_modules",
      },
    });

    const result = await inventoryProjectContext(spec);

    expect(result?.conventions).toContain("kebab-case");
    expect(result?.relevantFiles).toHaveLength(1);
    expect(result?.notes).toContain("node_modules");
  });

  it("degrades to null rather than inventing context when the scan fails", async () => {
    runStructuredQuery.mockResolvedValue({ ok: false, error: "boom" });

    expect(await inventoryProjectContext(spec)).toBeNull();
  });
});

describe("projectContextPromptSection", () => {
  it("is empty when there is no context", () => {
    expect(projectContextPromptSection(null)).toEqual([]);
  });

  it("includes relevant files by default", () => {
    const section = projectContextPromptSection({
      conventions: "conventions text",
      relevantFiles: [{ path: "src/a.ts", role: "helper" }],
      notes: "",
    }).join("\n");

    expect(section).toContain("conventions text");
    expect(section).toContain("src/a.ts");
  });

  it("omits relevant files when includeRelevantFiles is false", () => {
    const section = projectContextPromptSection(
      {
        conventions: "conventions text",
        relevantFiles: [{ path: "src/a.ts", role: "helper" }],
        notes: "",
      },
      { includeRelevantFiles: false },
    ).join("\n");

    expect(section).toContain("conventions text");
    expect(section).not.toContain("src/a.ts");
  });
});
