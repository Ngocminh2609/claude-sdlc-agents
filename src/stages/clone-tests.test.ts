import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isTestFile } from "../test-files.js";

const runStructuredQuery = vi.fn();
vi.mock("../sdk-helpers.js", () => ({ runStructuredQuery }));

const { runCloneTests, guardTestWrites } = await import("./clone-tests.js");

const reference = path.resolve("/tmp/reference");
const request = {
  clone: { what: "Chỉ tiêu", projectPath: "/tmp/be", referencePaths: [reference] },
  mapping: {
    entries: [
      { source: "a", target: "db/x.sql", group: "SQL", changes: "" },
      { source: "b", target: "src/main/java/x/Ctl.java", group: "BE", changes: "" },
    ],
    notes: "",
  },
  conventions: null,
  roots: [{ role: "app" as const, path: "/tmp/be" }],
  serverApi: ["- GET /stats-indicator/search -> Ctl.search"],
};

beforeEach(() => {
  runStructuredQuery.mockReset();
});

describe("isTestFile", () => {
  it("recognises the usual test locations and names", () => {
    for (const file of [
      "modules/category/src/test/java/x/CtlTest.java",
      "apps/meta/src/services/__tests__/api.test.ts",
      "apps/meta/src/services/apis/stats.spec.tsx",
      "C:\\be\\src\\test\\java\\SvcTest.java",
    ]) {
      expect(isTestFile(file)).toBe(true);
    }
  });

  it("does not treat code under test as a test file", () => {
    for (const file of ["src/main/java/x/Ctl.java", "apps/meta/src/services/apis/stats.ts", "src/latest/x.ts"]) {
      expect(isTestFile(file)).toBe(false);
    }
  });
});

describe("guardTestWrites", () => {
  const guard = guardTestWrites([reference]);

  it("lets the test stage write tests, and nothing else", async () => {
    expect((await guard("Write", { file_path: "src/test/java/x/CtlTest.java" }, {} as never))?.behavior).toBe("allow");
    expect((await guard("Edit", { file_path: "src/main/java/x/Ctl.java" }, {} as never))?.behavior).toBe("deny");
  });

  it("never writes into a reference repo, not even a test there", async () => {
    const inReference = path.join(reference, "src/test/java/XTest.java");
    expect((await guard("Write", { file_path: inReference }, {} as never))?.behavior).toBe("deny");
  });
});

describe("runCloneTests", () => {
  it("gives the agent the ported files by layer and the server routes to assert against", async () => {
    runStructuredQuery.mockResolvedValue({
      ok: true,
      data: { ok: true, summary: "8 passed", commands: ["mvn test"], testFiles: ["CtlTest.java"], failures: [] },
    });

    await runCloneTests(request);

    const [prompt, options] = runStructuredQuery.mock.calls[0];
    expect(prompt).toContain("DB:");
    expect(prompt).toContain("GET /stats-indicator/search");
    expect(options.allowedTools).not.toContain("Write");
  });

  it("does not count a pass with no tests written as a pass", async () => {
    runStructuredQuery.mockResolvedValue({
      ok: true,
      data: { ok: true, summary: "nothing to test", commands: [], testFiles: [], failures: [] },
    });

    expect((await runCloneTests(request)).ok).toBe(false);
  });

  it("re-runs with no write access at all", async () => {
    runStructuredQuery.mockResolvedValue({
      ok: true,
      data: { ok: true, summary: "8 passed", commands: ["mvn test"], testFiles: ["CtlTest.java"], failures: [] },
    });
    const first = { ok: false, summary: "", commands: ["mvn test"], testFiles: ["CtlTest.java"], failures: ["x"] };

    await runCloneTests({ ...request, rerun: first });

    const [prompt, options] = runStructuredQuery.mock.calls[0];
    expect(prompt).toContain("mvn test");
    expect((await options.canUseTool("Write", { file_path: "src/test/java/CtlTest.java" }, {})).behavior).toBe("deny");
  });

  it("fails closed when the agent returns no verdict", async () => {
    runStructuredQuery.mockResolvedValue({ ok: false, error: "rate_limit" });

    const verdict = await runCloneTests(request);

    expect(verdict.ok).toBe(false);
    expect(verdict.summary).toContain("rate_limit");
  });
});
