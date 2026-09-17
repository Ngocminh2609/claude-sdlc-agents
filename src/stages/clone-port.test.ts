import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloneInput, CloneMapping } from "../types.js";

const runTextQuery = vi.fn();
vi.mock("../sdk-helpers.js", () => ({ runTextQuery }));

const { portCloneGroup, portGroups } = await import("./clone-port.js");

const sample = path.resolve("/tmp/sample-app");
const clone: CloneInput = {
  what: "Danh mục nghề nghiệp",
  projectPath: "/tmp/target",
  referencePaths: [sample],
};

const mapping: CloneMapping = {
  entries: [
    { source: "sql/occ.sql", target: "SQL/occ.sql", group: "SQL", changes: "table prefix" },
    { source: "be/Ctl.java", target: "BE/Ctl.java", group: "BE", changes: "package com.fpt -> vn.gov" },
    { source: "fe/page.tsx", target: "FE/page.tsx", group: "FE", changes: "route path", uncertain: true },
  ],
  notes: "placed under modules/category",
};

function request(group: string) {
  return { clone, mapping, conventions: { summary: "modules/ layout" }, group, completedGroups: [] };
}

beforeEach(() => {
  runTextQuery.mockClear();
  runTextQuery.mockResolvedValue({ ok: true, text: "ported" });
});

describe("portGroups", () => {
  it("returns each group once, in the order the mapping lists them", () => {
    expect(portGroups(mapping)).toEqual(["SQL", "BE", "FE"]);
  });
});

describe("portCloneGroup", () => {
  it("gives the agent its own group's files with their required changes", async () => {
    await portCloneGroup(request("BE"));

    const [prompt] = runTextQuery.mock.calls[0];
    expect(prompt).toContain("be/Ctl.java");
    expect(prompt).toContain("package com.fpt -> vn.gov");
  });

  it("shows the whole mapping too, so a group knows what the others produce", async () => {
    await portCloneGroup(request("BE"));

    const [prompt] = runTextQuery.mock.calls[0];
    expect(prompt).toContain("[SQL] sql/occ.sql -> SQL/occ.sql");
    expect(prompt).toContain("[FE] fe/page.tsx -> FE/page.tsx");
    expect(prompt).toContain("placed under modules/category");
  });

  it("marks an uncertain entry so it is not ported silently", async () => {
    await portCloneGroup(request("FE"));

    const [prompt] = runTextQuery.mock.calls[0];
    expect(prompt).toContain("[UNCERTAIN]");
  });

  it("can read the reference repos", async () => {
    await portCloneGroup(request("BE"));

    const [, options] = runTextQuery.mock.calls[0];
    expect(options.additionalDirectories).toEqual([sample]);
  });

  it("cannot write into them — Write/Edit are gated, not allowed outright", async () => {
    await portCloneGroup(request("BE"));
    const [, options] = runTextQuery.mock.calls[0];

    expect(options.allowedTools).not.toContain("Write");
    expect(options.allowedTools).not.toContain("Edit");

    const denied = await options.canUseTool("Write", { file_path: path.join(sample, "be/Ctl.java") }, {});
    expect(denied.behavior).toBe("deny");

    const allowed = await options.canUseTool("Write", { file_path: "BE/Ctl.java" }, {});
    expect(allowed.behavior).toBe("allow");
  });

  it("blocks git-mutating and network-exfil commands like every writing stage", async () => {
    await portCloneGroup(request("BE"));

    const [, options] = runTextQuery.mock.calls[0];
    for (const pattern of ["Bash(git commit*)", "Bash(git push*)", "Bash(curl*)", "Bash(wget*)"]) {
      expect(options.disallowedTools).toContain(pattern);
    }
  });

  it("throws rather than reporting a silent success when the query fails", async () => {
    runTextQuery.mockResolvedValue({ ok: false, error: "boom" });

    await expect(portCloneGroup(request("BE"))).rejects.toThrow(/clone port failed on group BE/);
  });
});
