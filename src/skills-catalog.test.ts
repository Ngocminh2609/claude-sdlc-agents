import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeSkillCatalog,
  loadSkillCatalog,
  relevantSkillCatalog,
  skillCatalogFingerprint,
  skillCatalogPromptSection,
  withSkillDirs,
} from "./skills-catalog.js";
import type { ProjectRoot } from "./target-roots.js";
import type { CloneInput, SpecInput } from "./types.js";

const runTextQuery = vi.fn();
const runStructuredQuery = vi.fn();
vi.mock("./sdk-helpers.js", () => ({ runTextQuery, runStructuredQuery }));

const { runCoding, guardReferenceRepos } = await import("./stages/coding.js");
const { runSpecsArch } = await import("./stages/specs-arch.js");
const { portCloneGroup } = await import("./stages/clone-port.js");
const { mapCloneTargets } = await import("./stages/clone-mapping.js");

function skillsDirWith(...skills: { name: string; frontmatter: string }[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), "aidev-skills-"));
  for (const skill of skills) {
    const skillDir = path.join(dir, skill.name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), skill.frontmatter);
  }
  return dir;
}

const BACKEND = {
  name: "fis-backend-development",
  frontmatter:
    '---\nname: fis-backend-development\ndescription: "Build backends: APIs, auth, databases."\nkeywords: [backend, api, spring, java]\n---\nBody.',
};
const DATABASES = {
  name: "fis-databases",
  frontmatter:
    '---\nname: fis-databases\ndescription: "Design schemas and write queries."\nkeywords: [database, sql, schema]\n---\nBody.',
};
const ELICIT = {
  name: "fis-elicit",
  frontmatter: '---\nname: fis-elicit\ndescription: "BA elicitation toolkit."\nkeywords: [elicitation, interview, requirements]\n---\nBody.',
};

describe("loadSkillCatalog", () => {
  it("is empty for a target with neither a global nor a project skills directory", () => {
    const empty = path.join(mkdtempSync(path.join(tmpdir(), "aidev-none-")), "does-not-exist");
    const catalog = loadSkillCatalog([{ role: "app", path: mkdtempSync(path.join(tmpdir(), "aidev-target-")) }], empty);
    expect(catalog.entries).toEqual([]);
    expect(catalog.readOnlyDirs).toEqual([]);
    expect(catalog.totalInstalled).toBe(0);
  });

  it("reads the global catalog and exposes it read-only", () => {
    const global = skillsDirWith(BACKEND, DATABASES);
    const target = mkdtempSync(path.join(tmpdir(), "aidev-target-"));
    const catalog = loadSkillCatalog([{ role: "app", path: target }], global);
    expect(catalog.entries.map((entry) => entry.name)).toEqual(["fis-backend-development", "fis-databases"]);
    expect(catalog.entries[0].keywords).toEqual(["backend", "api", "spring", "java"]);
    expect(catalog.readOnlyDirs).toEqual([global]);
    expect(catalog.totalInstalled).toBe(2);
  });

  it("merges a project-local skills directory, and a same-named local skill wins over global", () => {
    const global = skillsDirWith(BACKEND, DATABASES);
    const target = mkdtempSync(path.join(tmpdir(), "aidev-target-"));
    mkdirSync(path.join(target, ".claude", "skills", "fis-backend-development"), { recursive: true });
    writeFileSync(
      path.join(target, ".claude", "skills", "fis-backend-development", "SKILL.md"),
      '---\nname: fis-backend-development\ndescription: "Project-specific override."\n---\n',
    );
    mkdirSync(path.join(target, ".claude", "skills", "local-only"), { recursive: true });
    writeFileSync(path.join(target, ".claude", "skills", "local-only", "SKILL.md"), '---\nname: local-only\ndescription: "Just here."\n---\n');

    const catalog = loadSkillCatalog([{ role: "app", path: target }], global);
    expect(catalog.entries.map((entry) => entry.name)).toEqual(["fis-backend-development", "fis-databases", "local-only"]);
    const backend = catalog.entries.find((entry) => entry.name === "fis-backend-development")!;
    expect(backend.description).toBe("Project-specific override.");
    // Only the global dir needs opening — the project skill is already inside a granted root.
    expect(catalog.readOnlyDirs).toEqual([global]);
  });

  it("skips a SKILL.md with no parseable frontmatter instead of failing the whole scan", () => {
    const global = skillsDirWith(BACKEND);
    mkdirSync(path.join(global, "broken"), { recursive: true });
    writeFileSync(path.join(global, "broken", "SKILL.md"), "no frontmatter here");
    const catalog = loadSkillCatalog([], global);
    expect(catalog.entries.map((entry) => entry.name)).toEqual(["fis-backend-development"]);
  });
});

describe("relevantSkillCatalog", () => {
  const global = skillsDirWith(BACKEND, DATABASES, ELICIT);
  const full = loadSkillCatalog([], global);

  it("drops a skill with no keyword/name/description overlap with the query", () => {
    const ranked = relevantSkillCatalog(full, "build a Spring Boot API for units", 6);
    expect(ranked.entries.map((entry) => entry.name)).toEqual(["fis-backend-development"]);
    expect(ranked.totalInstalled).toBe(3); // preserved for the progress line, unlike entries
  });

  it("ranks a skill's own keywords above words merely shared with its description", () => {
    // "schema" only appears in fis-databases' description; "sql" is one of its keywords too —
    // both should still outrank fis-backend-development, which shares nothing here.
    const ranked = relevantSkillCatalog(full, "design the sql schema for this table", 6);
    expect(ranked.entries.map((entry) => entry.name)).toEqual(["fis-databases"]);
  });

  it("matches an English keyword embedded in otherwise-Vietnamese prose", () => {
    const ranked = relevantSkillCatalog(full, "cần thu thập requirements từ người dùng", 6);
    expect(ranked.entries.map((entry) => entry.name)).toEqual(["fis-elicit"]);
  });

  it("normalizes Vietnamese diacritics so an accented word still tokenizes like its bare form", () => {
    // "cơ sở dữ liệu" has no direct keyword match, but "sql" appears bare in the same sentence;
    // the point here is just that normalize() doesn't throw or mis-split on combining marks.
    const ranked = relevantSkillCatalog(full, "cơ sở dữ liệu dùng sql", 6);
    expect(ranked.entries.map((entry) => entry.name)).toEqual(["fis-databases"]);
  });

  it("caps at the given limit even when more skills match", () => {
    const ranked = relevantSkillCatalog(full, "backend api database sql schema requirements interview", 2);
    expect(ranked.entries).toHaveLength(2);
  });

  it("returns an empty catalog, not a fallback top-N, when nothing matches at all", () => {
    const ranked = relevantSkillCatalog(full, "xyz completely unrelated topic", 6);
    expect(ranked.entries).toEqual([]);
    expect(ranked.totalInstalled).toBe(3);
  });
});

describe("describeSkillCatalog", () => {
  it("distinguishes nothing-installed, nothing-relevant, and a relevant subset", () => {
    expect(describeSkillCatalog(null)).toMatch(/none found/);
    const global = skillsDirWith(BACKEND, DATABASES);
    const full = loadSkillCatalog([], global);

    expect(describeSkillCatalog(relevantSkillCatalog(full, "totally unrelated", 6))).toBe(
      "Skills: 0/2 relevant to this task — none applied.",
    );
    expect(describeSkillCatalog(relevantSkillCatalog(full, "spring api backend", 6))).toBe(
      "Skills: 1/2 relevant (fis-backend-development)",
    );
  });
});

describe("withSkillDirs", () => {
  it("adds the catalog's read-only dirs without duplicating an already-listed one", () => {
    const global = skillsDirWith(BACKEND);
    const catalog = loadSkillCatalog([], global);
    expect(withSkillDirs(["/other"], catalog)).toEqual(["/other", global]);
    expect(withSkillDirs([global], catalog)).toEqual([global]);
    expect(withSkillDirs([], null)).toEqual([]);
  });
});

describe("skillCatalogPromptSection", () => {
  it("is empty without a catalog, and lists each entry with its path otherwise", () => {
    expect(skillCatalogPromptSection(null)).toEqual([]);
    const global = skillsDirWith(BACKEND);
    const text = skillCatalogPromptSection(loadSkillCatalog([], global)).join("\n");
    expect(text).toContain("fis-backend-development: Build backends: APIs, auth, databases.");
    expect(text).toContain(path.join(global, "fis-backend-development", "SKILL.md"));
  });
});

describe("skillCatalogFingerprint", () => {
  it("is null without a catalog, and changes when a description changes", () => {
    expect(skillCatalogFingerprint(null)).toBeNull();
    const a = loadSkillCatalog([], skillsDirWith(BACKEND));
    const b = loadSkillCatalog([], skillsDirWith({ ...BACKEND, frontmatter: BACKEND.frontmatter.replace("APIs", "endpoints") }));
    expect(skillCatalogFingerprint(a)).not.toEqual(skillCatalogFingerprint(b));
  });
});

describe("guardReferenceRepos with a skills directory", () => {
  it("denies writing into the skills catalog the same way it denies reference repos", async () => {
    const global = skillsDirWith(BACKEND);
    const guard = guardReferenceRepos([], [global]);
    const denied = await guard("Write", { file_path: path.join(global, "fis-backend-development", "SKILL.md") }, {} as never);
    expect(denied).toMatchObject({ behavior: "deny" });
    const allowed = await guard("Write", { file_path: "/tmp/target/App.java" }, {} as never);
    expect(allowed).toMatchObject({ behavior: "allow" });
  });
});

describe("the catalog reaches every stage that designs, reviews or writes code", () => {
  const MARKER = "--- Installed skills available for this task ---";

  beforeEach(() => {
    runTextQuery.mockReset();
    runStructuredQuery.mockReset();
    runTextQuery.mockResolvedValue({ ok: true, text: "done" });
    runStructuredQuery.mockResolvedValue({ ok: true, data: { summary: "ported", deviations: [] } });
  });

  it("specs & arch and coding, and neither without a catalog", async () => {
    for (const skillCatalog of [loadSkillCatalog([], skillsDirWith(BACKEND)), null]) {
      const spec: SpecInput = { specMarkdown: "build a widget", projectPath: "/tmp/project", skillCatalog };
      runTextQuery.mockClear();

      await runSpecsArch(spec, null, undefined);
      await runCoding({ spec, task: { id: "t1", description: "do it" }, approvedProposal: "d", completedTasks: [] });

      for (const [prompt] of runTextQuery.mock.calls) {
        if (skillCatalog) expect(prompt).toContain(MARKER);
        else expect(prompt).not.toContain(MARKER);
      }
    }
  });

  it("clone port", async () => {
    const clone: CloneInput = {
      what: "Danh mục đơn vị tính",
      projectPath: "/tmp/target",
      referencePaths: [path.resolve("/tmp/source")],
      skillCatalog: loadSkillCatalog([], skillsDirWith(BACKEND)),
    };
    await portCloneGroup({
      clone,
      mapping: { entries: [{ source: "a", target: "b", group: "BE", changes: "" }], notes: "" },
      conventions: null,
      group: "BE",
      completedGroups: [],
    });
    const [prompt] = runStructuredQuery.mock.calls[0];
    expect(prompt).toContain(MARKER);
  });

  it("clone mapping — the clone pipeline's design-equivalent stage", async () => {
    const clone: CloneInput = {
      what: "Danh mục đơn vị tính",
      projectPath: "/tmp/target",
      referencePaths: [path.resolve("/tmp/source")],
      skillCatalog: loadSkillCatalog([], skillsDirWith(BACKEND)),
    };
    runStructuredQuery.mockResolvedValue({ ok: true, data: { entries: [], notes: "" } });
    await mapCloneTargets(clone, { files: [], notes: "" }, null);
    const [prompt] = runStructuredQuery.mock.calls[0];
    expect(prompt).toContain(MARKER);
  });
});
