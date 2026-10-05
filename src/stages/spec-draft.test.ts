import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpecDraftInput } from "./spec-draft.js";

const runTextQuery = vi.fn();
vi.mock("../sdk-helpers.js", () => ({ runTextQuery }));

const { runSpecDraft, unwrapSpecMarkdown } = await import("./spec-draft.js");

const input: SpecDraftInput = { request: "thêm màn hình danh mục đơn vị tính", projectPath: "/tmp/project" };

beforeEach(() => {
  runTextQuery.mockReset();
});

describe("runSpecDraft", () => {
  it("only reads — no Write/Edit/Bash, the draft is text for a person to confirm", async () => {
    runTextQuery.mockResolvedValue({ ok: true, text: "# Spec" });

    await runSpecDraft(input);

    const [, options] = runTextQuery.mock.calls[0];
    expect(options.allowedTools).toEqual(["Read", "Glob", "Grep"]);
  });

  it("puts the request in the prompt and asks for the sections the pipeline relies on", async () => {
    runTextQuery.mockResolvedValue({ ok: true, text: "# Spec" });

    await runSpecDraft(input);

    const [prompt, options] = runTextQuery.mock.calls[0];
    expect(prompt).toContain("thêm màn hình danh mục đơn vị tính");
    for (const heading of ["## Bối cảnh", "## Yêu cầu", "## Ràng buộc", "## Tiêu chí nghiệm thu", "## Câu hỏi mở"]) {
      expect(options.systemPrompt).toContain(heading);
    }
  });

  it("opens reference repos and secondary target folders for reading", async () => {
    runTextQuery.mockResolvedValue({ ok: true, text: "# Spec" });

    await runSpecDraft({
      ...input,
      projectPath: "/tmp/be",
      targetRoots: [
        { role: "be", path: "/tmp/be" },
        { role: "fe", path: "/tmp/fe" },
      ],
      referencePaths: ["/tmp/sample"],
    });

    const [, options] = runTextQuery.mock.calls[0];
    // Reference paths come back resolved to the platform's absolute form.
    expect(options.additionalDirectories).toEqual(expect.arrayContaining(["/tmp/fe", path.resolve("/tmp/sample")]));
  });

  it("returns the draft without a fence wrapped around it", async () => {
    runTextQuery.mockResolvedValue({ ok: true, text: "```markdown\n# Spec\n\n## Yêu cầu\n- a\n```" });

    await expect(runSpecDraft(input)).resolves.toBe("# Spec\n\n## Yêu cầu\n- a\n");
  });

  it("throws a StageError-shaped message when the query fails or returns nothing", async () => {
    runTextQuery.mockResolvedValue({ ok: false, error: "rate_limit" });
    await expect(runSpecDraft(input)).rejects.toThrow(/spec-draft stage failed: rate_limit/);

    runTextQuery.mockResolvedValue({ ok: true, text: "   " });
    await expect(runSpecDraft(input)).rejects.toThrow(/spec-draft stage failed/);
  });
});

describe("unwrapSpecMarkdown", () => {
  it("leaves an unfenced spec as it is, ending in one newline", () => {
    expect(unwrapSpecMarkdown("# Spec\n\n```sql\nselect 1\n```\n\n")).toBe("# Spec\n\n```sql\nselect 1\n```\n");
  });
});
