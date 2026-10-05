import { beforeEach, describe, expect, it, vi } from "vitest";
import type { E2eCheck, ProjectContext, SpecInput } from "../types.js";

const runStructuredQuery = vi.fn();
vi.mock("../sdk-helpers.js", () => ({ runStructuredQuery }));

// The guard file and the Playwright re-run touch the disk and start processes;
// the verdict logic that combines them stays real.
const prepareE2e = vi.fn();
const runE2eCheck = vi.fn();
vi.mock("../e2e-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../e2e-check.js")>()),
  prepareE2e,
  runE2eCheck,
}));

const { runE2eTest } = await import("./e2e-test.js");

const spec: SpecInput = { specMarkdown: "build a widget", projectPath: "/tmp/project" };

const cleanCheck: E2eCheck = {
  ran: true,
  total: 2,
  passed: 2,
  failed: 0,
  flaky: 0,
  skipped: 0,
  failedTests: [],
  unguardedTests: [],
  apiProblems: [],
  evidenceDir: "/tmp/evidence",
};

const run = (input: SpecInput = spec, context: ProjectContext | null = null, ports: number[] = []) =>
  runE2eTest(input, "an approved proposal", context, ports, { evidenceDir: "/tmp/evidence" });

beforeEach(() => {
  runStructuredQuery.mockReset();
  prepareE2e.mockReset().mockResolvedValue(undefined);
  runE2eCheck.mockReset().mockResolvedValue(cleanCheck);
  runStructuredQuery.mockResolvedValue({ ok: true, data: { verdict: "pass", summary: "ok" } });
});

describe("runE2eTest", () => {
  it("does not put Write/Edit in allowedTools (they must be gated by canUseTool instead)", async () => {
    await run();

    const [, options] = runStructuredQuery.mock.calls[0];
    expect(options.allowedTools).not.toContain("Write");
    expect(options.allowedTools).not.toContain("Edit");
    expect(options.disallowedTools).toContain("Bash(curl*)");
    expect(options.disallowedTools).toContain("Bash(wget*)");
  });

  it("canUseTool allows writing e2e test files and playwright config", async () => {
    await run();
    const [, options] = runStructuredQuery.mock.calls[0];

    for (const filePath of ["e2e/login.spec.ts", "playwright.config.ts", "src/foo.spec.js"]) {
      const result = await options.canUseTool("Write", { file_path: filePath }, {});
      expect(result.behavior).toBe("allow");
    }
  });

  it("canUseTool denies writing/editing application source files", async () => {
    await run();
    const [, options] = runStructuredQuery.mock.calls[0];

    for (const toolName of ["Write", "Edit"]) {
      const result = await options.canUseTool(toolName, { file_path: "src/widget.ts" }, {});
      expect(result.behavior).toBe("deny");
      expect(result.message).toBeTruthy();
    }
  });

  it("canUseTool denies tools outside the allowed set (e.g. WebFetch)", async () => {
    await run();
    const [, options] = runStructuredQuery.mock.calls[0];

    const result = await options.canUseTool("WebFetch", {}, {});
    expect(result.behavior).toBe("deny");
  });

  it("includes project conventions but not the relevant-files list (a coding concern)", async () => {
    await run(spec, {
      conventions: "npm run dev starts the app on :3000",
      relevantFiles: [{ path: "src/widget-base.ts", role: "base class to extend" }],
      notes: "",
    });

    const [prompt] = runStructuredQuery.mock.calls[0];
    expect(prompt).toContain("npm run dev starts the app");
    expect(prompt).not.toContain("src/widget-base.ts");
  });

  it("gives the free ports to the agent and tells it to start every server the app needs", async () => {
    await run(spec, null, [50001, 50002]);

    const [prompt, options] = runStructuredQuery.mock.calls[0];
    expect(prompt).toContain("50001, 50002");
    expect(options.systemPrompt).toMatch(/EACH server/);
  });

  it("fails closed (does not silently pass) when the underlying query fails", async () => {
    runStructuredQuery.mockResolvedValue({ ok: false, error: "boom" });

    const result = await run();

    expect(result.verdict).toBe("fail");
    expect(runE2eCheck).not.toHaveBeenCalled();
  });
});

describe("runE2eTest — the pipeline's own check", () => {
  it("puts the guard in the FE folder and tells the agent to test through it", async () => {
    await run({ ...spec, projectPath: "/w/be", targetRoots: [{ role: "be", path: "/w/be" }, { role: "fe", path: "/w/fe" }] });

    expect(prepareE2e).toHaveBeenCalledWith("/w/fe");
    expect(runE2eCheck).toHaveBeenCalledWith("/w/fe", "/tmp/evidence", undefined);
    const [prompt] = runStructuredQuery.mock.calls[0];
    expect(prompt).toContain("aidev-guard");
    expect(prompt).toContain("apiGuard.allow");
  });

  it("passes only when the agent and the re-run both pass", async () => {
    const result = await run();

    expect(result.verdict).toBe("pass");
    expect(result.check).toEqual(cleanCheck);
    expect(result.summary).toContain("2/2 test(s) passed under the API guard");
  });

  it("fails on an API error the agent did not report, and names it", async () => {
    runE2eCheck.mockResolvedValue({
      ...cleanCheck,
      apiProblems: [{ test: "units › save", kind: "http", method: "POST", url: "http://localhost:5173/api/units", status: 500 }],
    });

    const result = await run();

    expect(result.verdict).toBe("fail");
    expect(result.failedScenarios?.join("\n")).toContain("POST http://localhost:5173/api/units answered HTTP 500");
  });

  it("fails when a test bypassed the guard, or nothing ran at all", async () => {
    runE2eCheck.mockResolvedValueOnce({ ...cleanCheck, unguardedTests: ["units › list"] });
    expect((await run()).verdict).toBe("fail");

    runE2eCheck.mockResolvedValueOnce({ ...cleanCheck, ran: false, error: "no playwright.config.* in /tmp/project" });
    const result = await run();
    expect(result.verdict).toBe("fail");
    expect(result.failedScenarios?.join("\n")).toContain("no playwright.config");
  });
});
