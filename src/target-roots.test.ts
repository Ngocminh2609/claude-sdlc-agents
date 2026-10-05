import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRoots,
  isSplit,
  rootPath,
  rootsOf,
  secondaryRootDirs,
  targetRootsPromptSection,
} from "./target-roots.js";

const be = path.resolve("/work/app-be");
const fe = path.resolve("/work/app-fe");
const app = path.resolve("/work/app");

describe("buildRoots", () => {
  it("keeps one project folder as a single app root", () => {
    expect(buildRoots({ project: app })).toEqual([{ role: "app", path: app }]);
  });

  it("puts BE first when both BE and FE are given", () => {
    expect(buildRoots({ fe, be })).toEqual([
      { role: "be", path: be },
      { role: "fe", path: fe },
    ]);
  });

  it("collapses BE and FE given as the same folder into one project", () => {
    expect(buildRoots({ be: app, fe: app })).toEqual([{ role: "app", path: app }]);
  });

  it("allows a BE-only or FE-only project", () => {
    expect(buildRoots({ fe })).toEqual([{ role: "fe", path: fe }]);
  });

  it("treats blank fields as absent", () => {
    expect(buildRoots({ be: "  ", fe: "" })).toEqual([]);
  });

  it("refuses one project folder and separate folders together", () => {
    expect(() => buildRoots({ project: app, be })).toThrow(/not both/);
  });

  it("adds a SQL folder last, never as the working directory", () => {
    const sql = path.resolve("/work/sql");
    expect(buildRoots({ be, fe, sql })).toEqual([
      { role: "be", path: be },
      { role: "fe", path: fe },
      { role: "sql", path: sql },
    ]);
    expect(buildRoots({ project: app, sql })).toEqual([
      { role: "app", path: app },
      { role: "sql", path: sql },
    ]);
  });

  it("drops a SQL folder that is a code folder already, and refuses one on its own", () => {
    expect(buildRoots({ be, sql: be })).toEqual([{ role: "be", path: be }]);
    expect(() => buildRoots({ sql: be })).toThrow(/needs a project folder/);
  });
});

describe("roots helpers", () => {
  const split = buildRoots({ be, fe });

  it("defaults an input with no roots to its project path", () => {
    expect(rootsOf({ projectPath: app })).toEqual([{ role: "app", path: app }]);
  });

  it("opens every folder but the working directory as an extra directory", () => {
    expect(secondaryRootDirs(split)).toEqual([fe]);
    expect(secondaryRootDirs([{ role: "app", path: app }])).toEqual([]);
  });

  it("resolves a role to its folder, falling back to the working directory", () => {
    expect(rootPath(split, "fe")).toBe(fe);
    expect(rootPath(split)).toBe(be);
    expect(rootPath([{ role: "app", path: app }], "fe")).toBe(app);
  });

  it("says nothing extra for a single-folder project", () => {
    expect(isSplit([{ role: "app", path: app }])).toBe(false);
    expect(targetRootsPromptSection([{ role: "app", path: app }])).toEqual([]);
  });

  it("names each folder and its role for a split project", () => {
    const text = targetRootsPromptSection(split).join("\n");
    expect(text).toContain(be);
    expect(text).toContain(fe);
    expect(text).toMatch(/BE \(server/);
    expect(text).toMatch(/FE \(client/);
  });
});
