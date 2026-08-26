import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpecInput } from "../types.js";

const runTextQuery = vi.fn();
vi.mock("../sdk-helpers.js", () => ({ runTextQuery }));

const { runSpecsArch } = await import("./specs-arch.js");

const spec: SpecInput = { specMarkdown: "build a widget", projectPath: "/tmp/project" };

beforeEach(() => {
  runTextQuery.mockClear();
});

describe("runSpecsArch", () => {
  it("does not grant Write/Edit/Bash — this stage only proposes, never modifies files", async () => {
    runTextQuery.mockResolvedValue({ ok: true, text: "a proposal" });

    await runSpecsArch(spec, null, undefined);

    const [, options] = runTextQuery.mock.calls[0];
    const allowed: string[] = options.allowedTools;
    for (const tool of ["Write", "Edit", "Bash"]) {
      expect(allowed).not.toContain(tool);
    }
  });

  it("includes db connection info in the prompt when present", async () => {
    runTextQuery.mockResolvedValue({ ok: true, text: "a proposal" });

    await runSpecsArch(
      { ...spec, dbInfo: { kind: "connection", value: "postgres://example" } },
      null,
      undefined,
    );

    const [prompt] = runTextQuery.mock.calls[0];
    expect(prompt).toContain("postgres://example");
  });

  it("includes the prior proposal and reviewer feedback in the revision prompt", async () => {
    runTextQuery.mockResolvedValue({ ok: true, text: "revised proposal" });

    await runSpecsArch(spec, "old proposal", "add more detail on rollback");

    const [prompt] = runTextQuery.mock.calls[0];
    expect(prompt).toContain("old proposal");
    expect(prompt).toContain("add more detail on rollback");
  });

  it("throws when the underlying query fails", async () => {
    runTextQuery.mockResolvedValue({ ok: false, error: "boom" });

    await expect(runSpecsArch(spec, null, undefined)).rejects.toThrow(/specs-arch stage failed/);
  });
});
