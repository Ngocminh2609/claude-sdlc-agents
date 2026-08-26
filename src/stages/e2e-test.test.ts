import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpecInput } from "../types.js";

const runStructuredQuery = vi.fn();
vi.mock("../sdk-helpers.js", () => ({ runStructuredQuery }));

const { runE2eTest } = await import("./e2e-test.js");

const spec: SpecInput = { specMarkdown: "build a widget", projectPath: "/tmp/project" };

beforeEach(() => {
  runStructuredQuery.mockClear();
});

describe("runE2eTest", () => {
  it("does not put Write/Edit in allowedTools (they must be gated by canUseTool instead)", async () => {
    runStructuredQuery.mockResolvedValue({ ok: true, data: { verdict: "pass", summary: "ok" } });

    await runE2eTest(spec, "an approved proposal");

    const [, options] = runStructuredQuery.mock.calls[0];
    expect(options.allowedTools).not.toContain("Write");
    expect(options.allowedTools).not.toContain("Edit");
    expect(options.disallowedTools).toContain("Bash(curl*)");
    expect(options.disallowedTools).toContain("Bash(wget*)");
  });

  it("canUseTool allows writing e2e test files and playwright config", async () => {
    runStructuredQuery.mockResolvedValue({ ok: true, data: { verdict: "pass", summary: "ok" } });
    await runE2eTest(spec, "an approved proposal");
    const [, options] = runStructuredQuery.mock.calls[0];

    for (const filePath of ["e2e/login.spec.ts", "playwright.config.ts", "src/foo.spec.js"]) {
      const result = await options.canUseTool("Write", { file_path: filePath }, {});
      expect(result.behavior).toBe("allow");
    }
  });

  it("canUseTool denies writing/editing application source files", async () => {
    runStructuredQuery.mockResolvedValue({ ok: true, data: { verdict: "pass", summary: "ok" } });
    await runE2eTest(spec, "an approved proposal");
    const [, options] = runStructuredQuery.mock.calls[0];

    for (const toolName of ["Write", "Edit"]) {
      const result = await options.canUseTool(toolName, { file_path: "src/widget.ts" }, {});
      expect(result.behavior).toBe("deny");
      expect(result.message).toBeTruthy();
    }
  });

  it("canUseTool denies tools outside the allowed set (e.g. WebFetch)", async () => {
    runStructuredQuery.mockResolvedValue({ ok: true, data: { verdict: "pass", summary: "ok" } });
    await runE2eTest(spec, "an approved proposal");
    const [, options] = runStructuredQuery.mock.calls[0];

    const result = await options.canUseTool("WebFetch", {}, {});
    expect(result.behavior).toBe("deny");
  });

  it("fails closed (does not silently pass) when the underlying query fails", async () => {
    runStructuredQuery.mockResolvedValue({ ok: false, error: "boom" });

    const result = await runE2eTest(spec, "an approved proposal");

    expect(result.verdict).toBe("fail");
  });
});
