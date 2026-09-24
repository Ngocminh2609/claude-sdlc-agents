import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpecInput } from "../types.js";

const runStructuredQuery = vi.fn();
vi.mock("../sdk-helpers.js", () => ({ runStructuredQuery }));

const { breakDownTasks } = await import("./task-breakdown.js");

const spec: SpecInput = { specMarkdown: "build a widget", projectPath: "/tmp/project" };

beforeEach(() => {
  runStructuredQuery.mockClear();
});

describe("breakDownTasks", () => {
  it("returns the SDK's task list on success", async () => {
    runStructuredQuery.mockResolvedValue({
      ok: true,
      data: { tasks: [{ id: "t1", description: "endpoint A" }, { id: "t2", description: "endpoint B" }] },
    });

    const result = await breakDownTasks(spec, "an approved proposal");

    expect(result.tasks).toHaveLength(2);
  });

  it("falls back to a single task covering the whole proposal when the query fails", async () => {
    runStructuredQuery.mockResolvedValue({ ok: false, error: "boom" });

    const result = await breakDownTasks(spec, "an approved proposal");

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].description).toBe("an approved proposal");
  });

  it("falls back to a single task when the SDK returns an empty task list", async () => {
    runStructuredQuery.mockResolvedValue({ ok: true, data: { tasks: [] } });

    const result = await breakDownTasks(spec, "an approved proposal");

    expect(result.tasks).toHaveLength(1);
  });

  it("includes the shared project context in the prompt when given", async () => {
    runStructuredQuery.mockResolvedValue({ ok: true, data: { tasks: [{ id: "t1", description: "a" }] } });

    await breakDownTasks(spec, "an approved proposal", null, {
      conventions: "one module per endpoint",
      relevantFiles: [],
      notes: "",
    });

    const [prompt] = runStructuredQuery.mock.calls[0];
    expect(prompt).toContain("one module per endpoint");
  });
});
