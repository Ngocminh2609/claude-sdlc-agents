import { describe, expect, it } from "vitest";
import { isValidRunId, specNameFromRunId } from "./runs.js";

describe("isValidRunId", () => {
  it("accepts the folder names RunLogger produces", () => {
    expect(isValidRunId("2026-09-08T05-34-52-193Z-CSDL-VIMO-spec-danh-muc-don-vi-tinh")).toBe(true);
  });

  it("rejects anything that could walk out of runs/", () => {
    for (const id of ["", "..", "../../etc/passwd", "a/b", "a\\b", ".hidden", "x".repeat(201)]) {
      expect(isValidRunId(id)).toBe(false);
    }
  });
});

describe("specNameFromRunId", () => {
  it("recovers the spec slug from the id and the logged project path", () => {
    expect(
      specNameFromRunId("2026-09-08T05-34-52-193Z-CSDL-VIMO-spec-units", "D:\\Source_Code\\CSDL-VIMO"),
    ).toBe("spec-units");
    expect(specNameFromRunId("2026-01-01T00-00-00-000Z-app-my-feature", "/home/me/app")).toBe(
      "my-feature",
    );
  });

  it("gives up rather than guessing when the pieces do not line up", () => {
    expect(specNameFromRunId("2026-09-08T05-34-52-193Z-app-spec", null)).toBeNull();
    expect(specNameFromRunId("no-timestamp-here", "/home/me/other")).toBeNull();
  });
});
