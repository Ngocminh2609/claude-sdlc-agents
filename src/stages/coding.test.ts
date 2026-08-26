import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpecInput, TaskItem } from "../types.js";

const runTextQuery = vi.fn();
vi.mock("../sdk-helpers.js", () => ({ runTextQuery }));

const { runCoding } = await import("./coding.js");

const spec: SpecInput = { specMarkdown: "build a widget", projectPath: "/tmp/project" };
const task: TaskItem = { id: "task-1", description: "implement the widget endpoint" };

beforeEach(() => {
  runTextQuery.mockClear();
});

describe("runCoding", () => {
  it("blocks git-mutating commands and network-exfil commands via disallowedTools", async () => {
    runTextQuery.mockResolvedValue({ ok: true, text: "done" });

    await runCoding(spec, task, undefined);

    const [, options] = runTextQuery.mock.calls[0];
    const disallowed: string[] = options.disallowedTools;
    for (const pattern of [
      "Bash(git commit*)",
      "Bash(git push*)",
      "Bash(git branch*)",
      "Bash(git checkout*)",
      "Bash(curl*)",
      "Bash(wget*)",
    ]) {
      expect(disallowed).toContain(pattern);
    }
  });

  it("includes the task description and target files in the prompt", async () => {
    runTextQuery.mockResolvedValue({ ok: true, text: "done" });

    await runCoding(spec, { ...task, targetFiles: ["src/widget.ts"] }, undefined);

    const [prompt] = runTextQuery.mock.calls[0];
    expect(prompt).toContain("implement the widget endpoint");
    expect(prompt).toContain("src/widget.ts");
  });

  it("throws when the underlying query fails", async () => {
    runTextQuery.mockResolvedValue({ ok: false, error: "boom" });

    await expect(runCoding(spec, task, undefined)).rejects.toThrow(/coding stage failed/);
  });
});
