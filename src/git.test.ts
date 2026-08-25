import { describe, expect, it } from "vitest";
import { slugify, branchNameFor } from "./git.js";

describe("slugify", () => {
  it("lowercases and collapses non-alphanumeric runs into single dashes", () => {
    expect(slugify("Add Dark Mode Support!")).toBe("add-dark-mode-support");
  });

  it("trims leading and trailing dashes", () => {
    expect(slugify("--Fix Bug--")).toBe("fix-bug");
  });

  it("truncates long titles to 50 characters", () => {
    const long = "a".repeat(100);
    expect(slugify(long).length).toBeLessThanOrEqual(50);
  });
});

describe("branchNameFor", () => {
  it("builds a branch name from issue number and slugified title", () => {
    expect(branchNameFor(42, "Add Dark Mode Support")).toBe(
      "ai/issue-42-add-dark-mode-support",
    );
  });
});
