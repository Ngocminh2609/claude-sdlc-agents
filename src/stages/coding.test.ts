import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueTask } from "../types.js";

const runTextQuery = vi.fn();
vi.mock("../sdk-helpers.js", () => ({ runTextQuery }));

const { runCoding } = await import("./coding.js");

const issue: IssueTask = { number: 1, title: "Test", body: "body", repoFullName: "org/repo" };

beforeEach(() => {
  runTextQuery.mockClear();
});

describe("runCoding", () => {
  it("blocks git-mutating commands and network-exfil commands via disallowedTools", async () => {
    runTextQuery.mockResolvedValue({ ok: true, text: "done" });

    await runCoding(issue, "a proposal", undefined);

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

  it("throws when the underlying query fails", async () => {
    runTextQuery.mockResolvedValue({ ok: false, error: "boom" });

    await expect(runCoding(issue, "a proposal", undefined)).rejects.toThrow(/coding stage failed/);
  });
});
