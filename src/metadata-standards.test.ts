import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  METADATA_MODULES,
  METADATA_STANDARDS_FILE,
  describeMetadataStandards,
  loadMetadataStandards,
  metadataStandardsPromptSection,
  type MetadataStandards,
} from "./metadata-standards.js";
import type { ProjectRoot } from "./target-roots.js";
import type { CloneInput, CloneMapping, SpecInput } from "./types.js";

const runTextQuery = vi.fn();
const runStructuredQuery = vi.fn();
vi.mock("./sdk-helpers.js", () => ({ runTextQuery, runStructuredQuery }));

const { runCoding } = await import("./stages/coding.js");
const { runSpecsArch } = await import("./stages/specs-arch.js");
const { reviewSpecs } = await import("./stages/orchestrator-review.js");
const { fixCloneFailures, portCloneGroup } = await import("./stages/clone-port.js");

function targetWith(config?: string): ProjectRoot {
  const dir = mkdtempSync(path.join(tmpdir(), "aidev-standards-"));
  if (config !== undefined) writeFileSync(path.join(dir, METADATA_STANDARDS_FILE), config);
  return { role: "app", path: dir };
}

const CONFIG = `mode: strict
modules: [CORE, SDC]
decisions:
  D5_authz_impl: spring-security-acl
agency: "vn.gso"
`;

describe("loadMetadataStandards", () => {
  it("returns null when the target has no config — other repos run exactly as before", () => {
    expect(loadMetadataStandards([targetWith()])).toBeNull();
  });

  it("returns null when the config opts out with no modules", () => {
    expect(loadMetadataStandards([targetWith("modules: []\n")])).toBeNull();
    expect(loadMetadataStandards([targetWith("modules: none\n")])).toBeNull();
  });

  it("reads mode and modules, keeping the config text verbatim", () => {
    const standards = loadMetadataStandards([targetWith(CONFIG)]);
    expect(standards?.mode).toBe("strict");
    expect(standards?.modules).toEqual(["CORE", "SDC"]);
    expect(standards?.configText).toContain("D5_authz_impl: spring-security-acl");
  });

  it("defaults to strict when mode is omitted", () => {
    expect(loadMetadataStandards([targetWith("modules: [CORE]\n")])?.mode).toBe("strict");
  });

  it("sends only the enabled modules' sections, plus the shared ones, and never the interactive protocol", () => {
    const rules = loadMetadataStandards([targetWith(CONFIG)])!.rules;
    for (const shared of ["## §0.", "## §2.", "## §3.", "## §13."]) expect(rules).toContain(shared);
    expect(rules).toContain("## §4. CORE");
    expect(rules).toContain("## §9. SDC");
    expect(rules).not.toContain("## §6. GSIM");
    expect(rules).not.toContain("## §10. AUTHZ");
    // §1 tells an interactive agent to ask the user; the config already answered.
    expect(rules).not.toContain("## §1.");
    expect(rules).not.toContain("## §12.");
  });

  it("finds a section for every module in the bundled guideline", () => {
    const all = loadMetadataStandards([targetWith(`modules: [${METADATA_MODULES.join(", ")}]\n`)]);
    expect(all?.modules).toEqual([...METADATA_MODULES]);
  });

  it("rejects an unknown module and an unknown mode before any stage runs", () => {
    expect(() => loadMetadataStandards([targetWith("modules: [CORE, FOO]\n")])).toThrow(/unknown module\(s\) FOO/);
    expect(() => loadMetadataStandards([targetWith("mode: loose\nmodules: [CORE]\n")])).toThrow(/mode must be/);
    expect(() => loadMetadataStandards([targetWith("modules: CORE\n")])).toThrow(/must be a list/);
  });

  it("accepts the same config in separate BE and FE folders, and refuses two different ones", () => {
    const be = { ...targetWith(CONFIG), role: "be" as const };
    const fe = { ...targetWith(CONFIG), role: "fe" as const };
    expect(loadMetadataStandards([be, fe])?.configPath).toBe(path.join(be.path, METADATA_STANDARDS_FILE));

    const other = { ...targetWith("modules: [CORE]\n"), role: "fe" as const };
    expect(() => loadMetadataStandards([be, other])).toThrow(/differs between/);
  });
});

describe("describeMetadataStandards", () => {
  it("says so when no standards apply, so a run never looks ruled when it is not", () => {
    expect(describeMetadataStandards(null)).toMatch(/not applied/);
    expect(describeMetadataStandards(loadMetadataStandards([targetWith(CONFIG)]))).toMatch(/CORE, SDC \(strict\)/);
  });
});

describe("metadataStandardsPromptSection", () => {
  const strict = () => loadMetadataStandards([targetWith(CONFIG)]) as MetadataStandards;

  it("is empty without standards", () => {
    expect(metadataStandardsPromptSection(null, "code")).toEqual([]);
    expect(metadataStandardsPromptSection(undefined, "design")).toEqual([]);
  });

  it("carries the config and the excerpt", () => {
    const text = metadataStandardsPromptSection(strict(), "code").join("\n");
    expect(text).toContain('agency: "vn.gso"');
    expect(text).toContain("## §4. CORE");
  });

  it("keeps the port faithful to its source in both modes", () => {
    const advisory = { ...strict(), mode: "advisory" as const };
    for (const standards of [strict(), advisory]) {
      expect(metadataStandardsPromptSection(standards, "port").join(" ")).toContain(
        "do not restructure ported logic",
      );
    }
  });

  it("never lets advisory mode reject a design over existing code", () => {
    const advisory = { ...strict(), mode: "advisory" as const };
    expect(metadataStandardsPromptSection(advisory, "review").join(" ")).toContain("Never reject over existing code");
  });
});

describe("the standards reach every stage that designs, reviews or writes code", () => {
  const standards = () => loadMetadataStandards([targetWith(CONFIG)]);
  const MARKER = "--- Metadata standards for this project";

  beforeEach(() => {
    runTextQuery.mockReset();
    runStructuredQuery.mockReset();
    runTextQuery.mockResolvedValue({ ok: true, text: "done" });
    runStructuredQuery.mockResolvedValue({
      ok: true,
      data: { decision: "approve", feedback: "ok", summary: "ported", deviations: [] },
    });
  });

  it("specs & arch, review and coding, and none of them without a config", async () => {
    for (const metadataStandards of [standards(), null]) {
      const spec: SpecInput = { specMarkdown: "build a widget", projectPath: "/tmp/project", metadataStandards };
      runTextQuery.mockClear();
      runStructuredQuery.mockClear();

      await runSpecsArch(spec, null, undefined);
      await runCoding({ spec, task: { id: "t1", description: "do it" }, approvedProposal: "d", completedTasks: [] });
      await reviewSpecs(spec, "a design");

      const prompts = [...runTextQuery.mock.calls, ...runStructuredQuery.mock.calls].map(([prompt]) => prompt);
      expect(prompts).toHaveLength(3);
      for (const prompt of prompts) {
        if (metadataStandards) expect(prompt).toContain(MARKER);
        else expect(prompt).not.toContain(MARKER);
      }
    }
  });

  it("clone port and clone fix", async () => {
    const clone: CloneInput = {
      what: "Danh mục đơn vị tính",
      projectPath: "/tmp/target",
      referencePaths: [path.resolve("/tmp/source")],
      metadataStandards: standards(),
    };
    const mapping: CloneMapping = {
      entries: [{ source: "be/Unit.java", target: "BE/Unit.java", group: "BE", changes: "package" }],
      notes: "",
    };

    await portCloneGroup({ clone, mapping, conventions: null, group: "BE", completedGroups: [] });
    await fixCloneFailures({ clone, mapping, conventions: null, failures: ["compile error"], serverApi: [], round: 1 });

    const [portPrompt, fixPrompt] = runStructuredQuery.mock.calls.map(([prompt]) => prompt);
    expect(portPrompt).toContain(MARKER);
    expect(portPrompt).toContain("do not restructure ported logic");
    expect(fixPrompt).toContain(MARKER);
    expect(fixPrompt).toContain("Do not use a fix round to refactor");
  });
});
