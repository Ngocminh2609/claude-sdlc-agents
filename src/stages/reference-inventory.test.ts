import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpecInput } from "../types.js";

const runStructuredQuery = vi.fn();
vi.mock("../sdk-helpers.js", () => ({ runStructuredQuery }));

const { inventoryReferences } = await import("./reference-inventory.js");

const sample = path.resolve("/tmp/sample-app");
const spec: SpecInput = {
  specMarkdown: "clone the units screen",
  projectPath: "/tmp/project",
  referencePaths: [sample],
};

beforeEach(() => {
  runStructuredQuery.mockClear();
});

describe("inventoryReferences", () => {
  it("does not call the model at all when there is no reference repo", async () => {
    const result = await inventoryReferences({ ...spec, referencePaths: [] });

    expect(result).toBeNull();
    expect(runStructuredQuery).not.toHaveBeenCalled();
  });

  it("reads the reference repos and nothing else — no write tools", async () => {
    runStructuredQuery.mockResolvedValue({ ok: true, data: { files: [], notes: "" } });

    await inventoryReferences(spec);

    const [prompt, options] = runStructuredQuery.mock.calls[0];
    expect(options.additionalDirectories).toEqual([sample]);
    expect(options.allowedTools).toEqual(["Read", "Glob", "Grep"]);
    expect(options.allowedTools).not.toContain("Write");
    expect(options.allowedTools).not.toContain("Edit");
    expect(options.allowedTools).not.toContain("Bash");
    expect(prompt).toContain(sample);
    expect(prompt).toContain("clone the units screen");
  });

  it("returns the file list the scan produced", async () => {
    runStructuredQuery.mockResolvedValue({
      ok: true,
      data: {
        files: [{ path: "src/units/UnitController.java", role: "REST endpoints for the screen" }],
        notes: "skipped target/ and node_modules",
      },
    });

    const result = await inventoryReferences(spec);

    expect(result?.files).toHaveLength(1);
    expect(result?.files[0].path).toBe("src/units/UnitController.java");
    expect(result?.notes).toContain("node_modules");
  });

  it("degrades to null rather than inventing a list when the scan fails", async () => {
    runStructuredQuery.mockResolvedValue({ ok: false, error: "boom" });

    expect(await inventoryReferences(spec)).toBeNull();
  });
});
