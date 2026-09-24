import { describe, expect, it } from "vitest";
import { runtimePortsPromptSection } from "./runtime-ports.js";

describe("runtimePortsPromptSection", () => {
  it("is empty when no ports are given", () => {
    expect(runtimePortsPromptSection([])).toEqual([]);
  });

  it("lists the ports and tells the agent not to assume defaults", () => {
    const text = runtimePortsPromptSection([50001, 50002]).join("\n");

    expect(text).toContain("50001, 50002");
    expect(text).toMatch(/default port/i);
    expect(text).toMatch(/address already in use/i);
  });

  it("forbids killing processes the agent did not start", () => {
    expect(runtimePortsPromptSection([50001]).join("\n")).toMatch(/never kill a process you did not start/i);
  });

  it("tells the agent to stop the servers it started", () => {
    expect(runtimePortsPromptSection([50001]).join("\n")).toMatch(/stop every server you started/i);
  });
});
