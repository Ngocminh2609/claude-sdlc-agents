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

  it("tells the design which database engine and scripts folder to plan for, never the connection itself", async () => {
    runTextQuery.mockResolvedValue({ ok: true, text: "a proposal" });

    await runSpecsArch(
      {
        ...spec,
        dbInfo: { kind: "connection", value: "" },
        database: { dialect: "postgresql", description: "PostgreSQL at db.local:5432/app", scriptsDir: "/tmp/sql" },
      },
      null,
      undefined,
    );

    const [prompt] = runTextQuery.mock.calls[0];
    expect(prompt).toContain("PostgreSQL at db.local:5432/app");
    expect(prompt).toContain("/tmp/sql");
    expect(prompt).not.toMatch(/postgres(ql)?:\/\//);
  });

  it("includes a schema file's content in the prompt", async () => {
    runTextQuery.mockResolvedValue({ ok: true, text: "a proposal" });

    await runSpecsArch({ ...spec, dbInfo: { kind: "schema-file", value: "CREATE TABLE unit (id int);" } }, null, undefined);

    const [prompt] = runTextQuery.mock.calls[0];
    expect(prompt).toContain("CREATE TABLE unit (id int);");
  });

  it("includes the prior proposal and reviewer feedback in the revision prompt", async () => {
    runTextQuery.mockResolvedValue({ ok: true, text: "revised proposal" });

    await runSpecsArch(spec, "old proposal", "add more detail on rollback");

    const [prompt] = runTextQuery.mock.calls[0];
    expect(prompt).toContain("old proposal");
    expect(prompt).toContain("add more detail on rollback");
  });

  it("includes the shared project context in the prompt when given", async () => {
    runTextQuery.mockResolvedValue({ ok: true, text: "a proposal" });

    await runSpecsArch(spec, null, undefined, null, {
      conventions: "kebab-case files, tests alongside source",
      relevantFiles: [{ path: "src/widget-base.ts", role: "base class to extend" }],
      notes: "",
    });

    const [prompt] = runTextQuery.mock.calls[0];
    expect(prompt).toContain("kebab-case files");
    expect(prompt).toContain("src/widget-base.ts");
  });

  it("throws when the underlying query fails", async () => {
    runTextQuery.mockResolvedValue({ ok: false, error: "boom" });

    await expect(runSpecsArch(spec, null, undefined)).rejects.toThrow(/specs-arch stage failed/);
  });
});
