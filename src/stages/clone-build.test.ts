import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloneMapping, TargetConventions } from "../types.js";

const runStructuredQuery = vi.fn();
vi.mock("../sdk-helpers.js", () => ({ runStructuredQuery }));

const { verifyCloneBuild } = await import("./clone-build.js");

const mapping: CloneMapping = {
  entries: [{ source: "be/Ctl.java", target: "BE/Ctl.java", group: "BE", changes: "package" }],
  notes: "",
};

beforeEach(() => {
  runStructuredQuery.mockClear();
});

describe("verifyCloneBuild", () => {
  it("cannot edit the code it is judging", async () => {
    runStructuredQuery.mockResolvedValue({ ok: true, data: { ok: true, summary: "compiled" } });

    await verifyCloneBuild(mapping);
    const [, options] = runStructuredQuery.mock.calls[0];

    expect(options.allowedTools).not.toContain("Write");
    expect(options.allowedTools).not.toContain("Edit");
    for (const toolName of ["Write", "Edit"]) {
      const result = await options.canUseTool(toolName, { file_path: "BE/Ctl.java" }, {});
      expect(result.behavior).toBe("deny");
    }
  });

  it("can run the build", async () => {
    runStructuredQuery.mockResolvedValue({ ok: true, data: { ok: true, summary: "compiled" } });

    await verifyCloneBuild(mapping);

    const [prompt, options] = runStructuredQuery.mock.calls[0];
    expect(options.allowedTools).toContain("Bash");
    expect(prompt).toContain("BE/Ctl.java");
  });

  it("passes a real verdict through", async () => {
    runStructuredQuery.mockResolvedValue({
      ok: true,
      data: { ok: false, command: "mvn -pl modules/category test-compile", summary: "1 error", errors: ["Ctl.java:12"] },
    });

    const verdict = await verifyCloneBuild(mapping);

    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toEqual(["Ctl.java:12"]);
  });

  it("gives the agent free ports in case the build check boots the app", async () => {
    runStructuredQuery.mockResolvedValue({ ok: true, data: { ok: true, summary: "compiled" } });

    await verifyCloneBuild(mapping, null, [50001, 50002]);

    const [prompt] = runStructuredQuery.mock.calls[0];
    expect(prompt).toContain("50001, 50002");
  });

  it("passes the target conventions through, so it can reuse a CI/CD build command Target Conventions already found", async () => {
    runStructuredQuery.mockResolvedValue({ ok: true, data: { ok: true, summary: "compiled" } });
    const conventions: TargetConventions = { summary: "CI runs: mvn -pl modules/category -am package -DskipTests" };

    await verifyCloneBuild(mapping, conventions);

    const [prompt] = runStructuredQuery.mock.calls[0];
    expect(prompt).toContain("mvn -pl modules/category -am package -DskipTests");
  });

  it("falls back to its own discovery when no conventions were given", async () => {
    runStructuredQuery.mockResolvedValue({ ok: true, data: { ok: true, summary: "compiled" } });

    await verifyCloneBuild(mapping);

    const [prompt] = runStructuredQuery.mock.calls[0];
    expect(prompt).toContain("Not available — work out the build from the project's own build files.");
  });

  it("fails closed: no verdict is not a pass", async () => {
    runStructuredQuery.mockResolvedValue({ ok: false, error: "boom" });

    const verdict = await verifyCloneBuild(mapping);

    expect(verdict.ok).toBe(false);
    expect(verdict.summary).toContain("no verdict");
  });
});
