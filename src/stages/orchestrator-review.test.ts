import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpecInput } from "../types.js";

const runStructuredQuery = vi.fn();
vi.mock("../sdk-helpers.js", () => ({ runStructuredQuery }));

const { reviewSpecs } = await import("./orchestrator-review.js");

const spec: SpecInput = { specMarkdown: "build a widget", projectPath: "/tmp/project" };

beforeEach(() => {
  runStructuredQuery.mockClear();
});

describe("reviewSpecs", () => {
  it("returns the SDK's decision on success", async () => {
    runStructuredQuery.mockResolvedValue({
      ok: true,
      data: { decision: "approve", feedback: "looks good" },
    });

    const result = await reviewSpecs(spec, "a proposal");

    expect(result.decision).toBe("approve");
  });

  it("fails closed to reject (not a silent approve) when the underlying query fails", async () => {
    runStructuredQuery.mockResolvedValue({ ok: false, error: "boom" });

    const result = await reviewSpecs(spec, "a proposal");

    expect(result.decision).toBe("reject");
  });

  it("lets the reviewer approve with exact fixes instead of rejecting over them", async () => {
    runStructuredQuery.mockResolvedValue({
      ok: true,
      data: { decision: "approve", feedback: "ok", amendments: ["add sql.init.mode"] },
    });

    const verdict = await reviewSpecs(spec, "a proposal");

    const [, options, schema] = runStructuredQuery.mock.calls[0];
    expect(schema.properties.amendments).toBeDefined();
    expect(options.systemPrompt).toMatch(/Do not reject over a problem you could have written as an amendment/);
    expect(verdict.amendments).toEqual(["add sql.init.mode"]);
  });
});
