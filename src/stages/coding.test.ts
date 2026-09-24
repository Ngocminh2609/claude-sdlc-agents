import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingRequest } from "./coding.js";
import type { SpecInput, TaskItem } from "../types.js";

const runTextQuery = vi.fn();
vi.mock("../sdk-helpers.js", () => ({ runTextQuery }));

const { runCoding } = await import("./coding.js");
const { StageError } = await import("../stage-error.js");

const spec: SpecInput = { specMarkdown: "build a widget", projectPath: "/tmp/project" };
const task: TaskItem = { id: "task-1", description: "implement the widget endpoint" };
const sample = path.resolve("/tmp/sample-app");

function request(overrides: Partial<CodingRequest> = {}): CodingRequest {
  return {
    spec,
    task,
    approvedProposal: "the approved design",
    completedTasks: [],
    ...overrides,
  };
}

beforeEach(() => {
  runTextQuery.mockClear();
  runTextQuery.mockResolvedValue({ ok: true, text: "done" });
});

describe("runCoding", () => {
  it("blocks git-mutating commands and network-exfil commands via disallowedTools", async () => {
    await runCoding(request());

    const [, options] = runTextQuery.mock.calls[0];
    for (const pattern of [
      "Bash(git commit*)",
      "Bash(git push*)",
      "Bash(git branch*)",
      "Bash(git checkout*)",
      "Bash(curl*)",
      "Bash(wget*)",
    ]) {
      expect(options.disallowedTools).toContain(pattern);
    }
  });

  it("includes the task description and target files in the prompt", async () => {
    await runCoding(request({ task: { ...task, targetFiles: ["src/widget.ts"] } }));

    const [prompt] = runTextQuery.mock.calls[0];
    expect(prompt).toContain("implement the widget endpoint");
    expect(prompt).toContain("src/widget.ts");
  });

  it("passes the approved design through, so every task implements the same one", async () => {
    await runCoding(request());

    const [prompt] = runTextQuery.mock.calls[0];
    expect(prompt).toContain("the approved design");
  });

  it("tells the task what earlier tasks in this pass already built", async () => {
    await runCoding(
      request({
        completedTasks: [
          { id: "task-1", description: "the API", summary: "added GET /api/units returning UnitDto" },
        ],
      }),
    );

    const [prompt] = runTextQuery.mock.calls[0];
    expect(prompt).toContain("task-1");
    expect(prompt).toContain("GET /api/units");
  });

  it("truncates a long prior summary instead of letting it crowd out the task", async () => {
    await runCoding(
      request({
        completedTasks: [{ id: "task-1", description: "the API", summary: "x".repeat(5000) }],
      }),
    );

    const [prompt] = runTextQuery.mock.calls[0];
    expect(prompt).toContain("(truncated)");
    expect(prompt.length).toBeLessThan(5000);
  });

  it("throws a StageError naming the task when the underlying query fails", async () => {
    runTextQuery.mockResolvedValue({ ok: false, error: "boom" });

    await expect(runCoding(request())).rejects.toBeInstanceOf(StageError);
    await expect(runCoding(request())).rejects.toThrow(/coding stage failed on task task-1/);
  });

  it("includes the free ports for any server the task starts", async () => {
    await runCoding(request({ runtimePorts: [50001, 50002] }));

    const [prompt] = runTextQuery.mock.calls[0];
    expect(prompt).toContain("50001, 50002");
  });

  it("includes the shared project context in the prompt when given", async () => {
    await runCoding(
      request({
        projectContext: {
          conventions: "kebab-case files, tests alongside source",
          relevantFiles: [{ path: "src/widget-base.ts", role: "base class to extend" }],
          notes: "",
        },
      }),
    );

    const [prompt] = runTextQuery.mock.calls[0];
    expect(prompt).toContain("kebab-case files");
    expect(prompt).toContain("src/widget-base.ts");
  });
});

describe("runCoding with reference repositories", () => {
  const withReference: SpecInput = { ...spec, referencePaths: [sample] };

  it("adds them to additionalDirectories and names them in the prompt", async () => {
    await runCoding(request({ spec: withReference }));

    const [prompt, options] = runTextQuery.mock.calls[0];
    expect(options.additionalDirectories).toEqual([sample]);
    expect(prompt).toContain(sample);
    expect(prompt).toContain("READ-ONLY");
  });

  it("leaves additionalDirectories unset when there is no reference repo", async () => {
    await runCoding(request());

    const [, options] = runTextQuery.mock.calls[0];
    expect(options.additionalDirectories).toBeUndefined();
  });

  it("does not put Write/Edit in allowedTools (they must be gated by canUseTool instead)", async () => {
    await runCoding(request({ spec: withReference }));

    const [, options] = runTextQuery.mock.calls[0];
    expect(options.allowedTools).not.toContain("Write");
    expect(options.allowedTools).not.toContain("Edit");
  });

  it("canUseTool denies writing into a reference repo", async () => {
    await runCoding(request({ spec: withReference }));
    const [, options] = runTextQuery.mock.calls[0];

    for (const toolName of ["Write", "Edit"]) {
      const result = await options.canUseTool(toolName, { file_path: path.join(sample, "src/x.ts") }, {});
      expect(result.behavior).toBe("deny");
      expect(result.message).toBeTruthy();
    }
  });

  it("canUseTool still allows writing into the target project", async () => {
    await runCoding(request({ spec: withReference }));
    const [, options] = runTextQuery.mock.calls[0];

    const result = await options.canUseTool("Write", { file_path: "src/widget.ts" }, {});
    expect(result.behavior).toBe("allow");
  });

  it("canUseTool allows every write when no reference repo is configured", async () => {
    await runCoding(request());
    const [, options] = runTextQuery.mock.calls[0];

    const result = await options.canUseTool("Edit", { file_path: path.join(sample, "src/x.ts") }, {});
    expect(result.behavior).toBe("allow");
  });

  it("canUseTool denies tools outside the allowed set", async () => {
    await runCoding(request());
    const [, options] = runTextQuery.mock.calls[0];

    expect((await options.canUseTool("WebFetch", {}, {})).behavior).toBe("deny");
  });
});
