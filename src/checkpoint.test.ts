import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkpointPath, clearCheckpoint, fingerprint, loadCheckpoint, saveCheckpoint } from "./checkpoint.js";

// A project path no real run uses, so these tests never touch a real checkpoint.
const project = path.resolve("/tmp/aidev-checkpoint-test-project");

afterEach(async () => {
  await clearCheckpoint("feature", project);
  await clearCheckpoint("clone", project);
});

describe("checkpoint", () => {
  it("reports none when nothing was saved", async () => {
    expect(await loadCheckpoint("feature", project, "fp")).toEqual({ status: "none" });
  });

  it("loads back what was saved for the same fingerprint", async () => {
    await saveCheckpoint("feature", project, "fp-1", { tasks: ["a"] });

    const loaded = await loadCheckpoint<{ tasks: string[] }>("feature", project, "fp-1");

    expect(loaded.status).toBe("found");
    if (loaded.status === "found") {
      expect(loaded.data).toEqual({ tasks: ["a"] });
      expect(Date.parse(loaded.savedAt)).not.toBeNaN();
    }
  });

  it("reports stale when the inputs changed since it was saved", async () => {
    await saveCheckpoint("feature", project, "fp-old", { tasks: [] });

    expect((await loadCheckpoint("feature", project, "fp-new")).status).toBe("stale");
  });

  it("keeps feature and clone progress for the same project apart", async () => {
    await saveCheckpoint("feature", project, "fp", { kind: "feature" });

    expect((await loadCheckpoint("clone", project, "fp")).status).toBe("none");
  });

  it("treats a corrupt file as nothing to resume rather than throwing", async () => {
    await saveCheckpoint("feature", project, "fp", { ok: true });
    await writeFile(checkpointPath("feature", project), "{ not json", "utf-8");

    expect(await loadCheckpoint("feature", project, "fp")).toEqual({ status: "none" });
  });

  it("clears what was saved", async () => {
    await saveCheckpoint("feature", project, "fp", { ok: true });
    await clearCheckpoint("feature", project);

    expect((await loadCheckpoint("feature", project, "fp")).status).toBe("none");
  });

  it("writes under this repo's runs/, never inside the target project", async () => {
    await saveCheckpoint("feature", project, "fp", { ok: true });
    const file = checkpointPath("feature", project);

    expect(file.startsWith(project)).toBe(false);
    expect(path.basename(path.dirname(file))).toBe("runs");
    expect(JSON.parse(await readFile(file, "utf-8")).data).toEqual({ ok: true });
  });

  it("gives the same fingerprint for the same inputs and a different one otherwise", () => {
    expect(fingerprint(["spec", ["a"]])).toBe(fingerprint(["spec", ["a"]]));
    expect(fingerprint(["spec", ["a"]])).not.toBe(fingerprint(["spec edited", ["a"]]));
  });
});
