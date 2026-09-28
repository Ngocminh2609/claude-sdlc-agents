import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloneInput, CloneMapping } from "../types.js";

const runStructuredQuery = vi.fn();
vi.mock("../sdk-helpers.js", () => ({ runStructuredQuery }));

const { fixCloneFailures, layerOf, portCloneGroup, portGroups } = await import("./clone-port.js");

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
  runStructuredQuery.mockClear();
  runStructuredQuery.mockResolvedValue({ ok: true, data: { summary: "ported", deviations: [] } });
});

describe("portGroups", () => {
  it("returns each group once, in the order the mapping lists them", () => {
    expect(portGroups(mapping)).toEqual(["SQL", "BE", "FE"]);
  });

  it("puts database, then server, then client first — inferring the layer when the mapping did not say", () => {
    const shuffled: CloneMapping = {
      entries: [
        { source: "p", target: "apps/x/src/pages/a.tsx", group: "FE:page", changes: "" },
        { source: "c", target: "src/main/java/Ctl.java", group: "BE:api", changes: "" },
        { source: "(new)", target: "src/main/resources/db/a-schema.sql", group: "SQL", changes: "" },
        { source: "c2", target: "src/main/java/Svc.java", root: "be", group: "BE:svc", changes: "" },
      ],
      notes: "",
    };
    expect(portGroups(shuffled)).toEqual(["SQL", "BE:api", "BE:svc", "FE:page"]);
    expect(layerOf(shuffled.entries[0])).toBe("fe");
    expect(layerOf({ ...shuffled.entries[0], layer: "be" })).toBe("be");
  });
});

describe("the client group's server contract", () => {
  it("is put in the prompt when given, and absent otherwise", async () => {
    await portCloneGroup({ ...request("FE"), serverApi: ["- GET /occ/search -> OccController.search"] });
    await portCloneGroup(request("BE"));

    expect(runStructuredQuery.mock.calls[0][0]).toContain("GET /occ/search -> OccController.search");
    expect(runStructuredQuery.mock.calls[1][0]).not.toContain("server API this client must call");
  });
});

describe("fixCloneFailures", () => {
  it("can fix the code under test but not the tests themselves", async () => {
    runStructuredQuery.mockResolvedValue({ ok: true, data: { summary: "fixed the delete route" } });

    const summary = await fixCloneFailures({
      clone,
      mapping,
      conventions: null,
      failures: ["[test] CtlTest.delete: 500"],
      serverApi: [],
      round: 1,
    });

    const [prompt, options] = runStructuredQuery.mock.calls[0];
    expect(summary).toBe("fixed the delete route");
    expect(prompt).toContain("CtlTest.delete: 500");
    expect((await options.canUseTool("Edit", { file_path: "BE/Ctl.java" }, {})).behavior).toBe("allow");
    expect((await options.canUseTool("Edit", { file_path: "src/test/java/CtlTest.java" }, {})).behavior).toBe("deny");
    expect((await options.canUseTool("Write", { file_path: path.join(sample, "be/Ctl.java") }, {})).behavior).toBe("deny");
  });
});

describe("portCloneGroup", () => {
  it("gives the agent free ports for any server it starts to check its work", async () => {
    await portCloneGroup({ ...request("BE"), runtimePorts: [50001, 50002] });

    const [prompt] = runStructuredQuery.mock.calls[0];
    expect(prompt).toContain("50001, 50002");
  });

  it("gives the agent its own group's files with their required changes", async () => {
    await portCloneGroup(request("BE"));

    const [prompt] = runStructuredQuery.mock.calls[0];
    expect(prompt).toContain("be/Ctl.java");
    expect(prompt).toContain("package com.fpt -> vn.gov");
  });

  it("shows the whole mapping too, so a group knows what the others produce", async () => {
    await portCloneGroup(request("BE"));

    const [prompt] = runStructuredQuery.mock.calls[0];
    expect(prompt).toContain("[SQL] sql/occ.sql -> SQL/occ.sql");
    expect(prompt).toContain("[FE] fe/page.tsx -> FE/page.tsx");
    expect(prompt).toContain("placed under modules/category");
  });

  it("marks an uncertain entry so it is not ported silently", async () => {
    await portCloneGroup(request("FE"));

    const [prompt] = runStructuredQuery.mock.calls[0];
    expect(prompt).toContain("[UNCERTAIN]");
  });

  it("can read the reference repos", async () => {
    await portCloneGroup(request("BE"));

    const [, options] = runStructuredQuery.mock.calls[0];
    expect(options.additionalDirectories).toEqual([sample]);
  });

  it("cannot write into them — Write/Edit are gated, not allowed outright", async () => {
    await portCloneGroup(request("BE"));
    const [, options] = runStructuredQuery.mock.calls[0];

    expect(options.allowedTools).not.toContain("Write");
    expect(options.allowedTools).not.toContain("Edit");

    const denied = await options.canUseTool("Write", { file_path: path.join(sample, "be/Ctl.java") }, {});
    expect(denied.behavior).toBe("deny");

    const allowed = await options.canUseTool("Write", { file_path: "BE/Ctl.java" }, {});
    expect(allowed.behavior).toBe("allow");
  });

  it("blocks git-mutating and network-exfil commands like every writing stage", async () => {
    await portCloneGroup(request("BE"));

    const [, options] = runStructuredQuery.mock.calls[0];
    for (const pattern of ["Bash(git commit*)", "Bash(git push*)", "Bash(curl*)", "Bash(wget*)"]) {
      expect(options.disallowedTools).toContain(pattern);
    }
  });

  it("tells the agent to declare every file it does not write where the mapping says", async () => {
    await portCloneGroup(request("BE"));

    const [, options, schema] = runStructuredQuery.mock.calls[0];
    expect(schema.properties.deviations).toBeDefined();
    expect(options.systemPrompt).toMatch(/neither written nor declared is\s+reported to the user as missing/);
  });

  it("keeps only deviations about its own group's files", async () => {
    runStructuredQuery.mockResolvedValue({
      ok: true,
      data: {
        summary: "ported",
        deviations: [
          { target: "BE/Ctl.java", kind: "merged", coveredBy: "BE/Svc.java", reason: "one class per entity" },
          { target: "FE/page.tsx", kind: "not-needed", reason: "someone else's file" },
        ],
      },
    });

    const result = await portCloneGroup(request("BE"));

    expect(result.deviations.map((deviation) => deviation.target)).toEqual(["BE/Ctl.java"]);
  });

  it("throws rather than reporting a silent success when the query fails", async () => {
    runStructuredQuery.mockResolvedValue({ ok: false, error: "boom" });

    await expect(portCloneGroup(request("BE"))).rejects.toThrow(/clone port failed on group BE/);
  });
});
