import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueTask } from "../types.js";

const runStructuredQuery = vi.fn();
vi.mock("../sdk-helpers.js", () => ({ runStructuredQuery }));

const { runQa } = await import("./qa.js");

const issue: IssueTask = { number: 1, title: "Test", body: "body", repoFullName: "org/repo" };

beforeEach(() => {
  runStructuredQuery.mockClear();
});

describe("runQa", () => {
  it("blocks Write/Edit and network-exfil commands via disallowedTools", async () => {
    runStructuredQuery.mockResolvedValue({ ok: true, data: { verdict: "pass", summary: "ok" } });

    await runQa(issue, "a proposal");

    const [, options] = runStructuredQuery.mock.calls[0];
    const disallowed: string[] = options.disallowedTools;
    for (const pattern of ["Write", "Edit", "Bash(curl*)", "Bash(wget*)"]) {
      expect(disallowed).toContain(pattern);
    }
  });

  it("fails closed (does not silently pass) when the underlying query fails", async () => {
    runStructuredQuery.mockResolvedValue({ ok: false, error: "boom" });

    const result = await runQa(issue, "a proposal");

    expect(result.verdict).toBe("fail");
  });
});
