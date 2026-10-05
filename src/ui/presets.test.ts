import { beforeEach, describe, expect, it, vi } from "vitest";

// An in-memory stand-in for the UI state file.
let stored: string | null = null;
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal()),
  readFile: vi.fn(async () => {
    if (stored === null) throw new Error("ENOENT");
    return stored;
  }),
  writeFile: vi.fn(async (_file: string, content: string) => {
    stored = content;
  }),
}));

const { listPresets, savePreset } = await import("./presets.js");

const base = {
  projectPath: "",
  projectBe: "D:/target/BE",
  projectFe: "D:/target/FE",
  projectSql: "",
  specDir: "",
  specPath: "",
  dbMode: "none" as const,
  dbSchemaPath: "",
  referencePath: "",
  what: "",
  cloneFromBe: "",
  cloneFromFe: "",
};

beforeEach(() => {
  stored = null;
});

describe("presets", () => {
  it("reads a preset saved before the flows were split as a feature preset", async () => {
    stored = JSON.stringify({
      presets: [{ id: "a", name: "old", projectPath: "D:/app", specPath: "D:/spec.md", dbMode: "none" }],
    });

    const [preset] = await listPresets();

    expect(preset.mode).toBe("feature");
    expect(preset.specPath).toBe("D:/spec.md");
    expect(preset.what).toBe("");
  });

  it("keeps a clone preset and a feature preset of the same name apart", async () => {
    await savePreset({ ...base, name: "CSDL", mode: "feature", specPath: "D:/spec.md" });
    await savePreset({ ...base, name: "csdl", mode: "clone", what: "nghề nghiệp", cloneFromBe: "D:/mau/BE" });

    const presets = await listPresets();

    expect(presets.map((p) => p.mode).sort()).toEqual(["clone", "feature"]);
    expect(presets.find((p) => p.mode === "clone")?.what).toBe("nghề nghiệp");
    expect(presets.find((p) => p.mode === "feature")?.specPath).toBe("D:/spec.md");
  });

  it("updates in place when the same name is saved again in the same flow", async () => {
    await savePreset({ ...base, name: "CSDL", mode: "clone", what: "đơn vị tính" });
    const [first] = await listPresets();
    await savePreset({ ...base, name: "csdl", mode: "clone", what: "nghề nghiệp" });

    const presets = await listPresets();

    expect(presets).toHaveLength(1);
    expect(presets[0].id).toBe(first.id);
    expect(presets[0].what).toBe("nghề nghiệp");
  });
});
