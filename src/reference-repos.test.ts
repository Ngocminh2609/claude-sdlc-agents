import path from "node:path";
import { describe, expect, it } from "vitest";
import { isInsideReference, referenceDirectories, referencePromptSection } from "./reference-repos.js";

const sample = path.resolve("/tmp/sample-app");

describe("referenceDirectories", () => {
  it("is empty when no reference was given, so nothing is added to the options", () => {
    expect(referenceDirectories(undefined)).toEqual([]);
    expect(referenceDirectories([])).toEqual([]);
  });

  it("resolves relative paths to absolute ones, as the SDK requires", () => {
    expect(referenceDirectories(["./sample"])).toEqual([path.resolve("./sample")]);
  });
});

describe("referencePromptSection", () => {
  it("says nothing when there is no reference repo", () => {
    expect(referencePromptSection([])).toEqual([]);
  });

  it("names the directories and states they are read-only", () => {
    const section = referencePromptSection([sample]).join("\n");
    // Normalised: the prompt is hard-wrapped, so the sentence spans lines.
    const flat = section.replace(/\s+/g, " ");

    expect(section).toContain(sample);
    expect(section).toContain("READ-ONLY");
    expect(flat).toMatch(/Do not create, edit or delete anything inside a reference repository/i);
  });
});

describe("referencePromptSection with an inventory", () => {
  const inventory = {
    files: [{ path: "src/units/UnitController.java", role: "REST endpoints" }],
    notes: "skipped target/",
  };

  it("lists the inventoried files as the checklist to work through", () => {
    const section = referencePromptSection([sample], inventory).join("\n");

    expect(section).toContain("src/units/UnitController.java");
    expect(section).toContain("REST endpoints");
    expect(section).toContain("skipped target/");
    expect(section.replace(/\s+/g, " ")).toMatch(/do not silently skip one that is/i);
  });

  it("says nothing extra when the scan produced no list", () => {
    const withoutList = referencePromptSection([sample], null).join("\n");
    const emptyList = referencePromptSection([sample], { files: [], notes: "" }).join("\n");

    expect(withoutList).not.toContain("already inventoried");
    expect(emptyList).not.toContain("already inventoried");
  });

  it("stays silent when there is no reference repo at all, inventory or not", () => {
    expect(referencePromptSection([], inventory)).toEqual([]);
  });
});

describe("isInsideReference", () => {
  it("matches the directory itself and anything under it", () => {
    expect(isInsideReference(sample, [sample])).toBe(true);
    expect(isInsideReference(path.join(sample, "src", "widget.ts"), [sample])).toBe(true);
  });

  it("does not match a sibling whose name merely starts the same", () => {
    expect(isInsideReference(path.resolve("/tmp/sample-app-2/src/x.ts"), [sample])).toBe(false);
  });

  it("does not match paths outside every reference", () => {
    expect(isInsideReference(path.resolve("/tmp/target/src/x.ts"), [sample])).toBe(false);
    expect(isInsideReference("/tmp/anything", [])).toBe(false);
    expect(isInsideReference("", [sample])).toBe(false);
  });

  it("cannot be escaped by traversing back out and in again", () => {
    expect(isInsideReference(path.join(sample, "..", "target", "x.ts"), [sample])).toBe(false);
    expect(isInsideReference(path.join(sample, "..", "sample-app", "x.ts"), [sample])).toBe(true);
  });
});
