import { describe, expect, it } from "vitest";
import { encodeEvent, eventStreamEnabled, parseEventLine } from "./events.js";

describe("eventStreamEnabled", () => {
  it("is off unless the variable is exactly \"1\"", () => {
    expect(eventStreamEnabled({})).toBe(false);
    expect(eventStreamEnabled({ AIDEV_EVENT_STREAM: "" })).toBe(false);
    expect(eventStreamEnabled({ AIDEV_EVENT_STREAM: "true" })).toBe(false);
    expect(eventStreamEnabled({ AIDEV_EVENT_STREAM: "1" })).toBe(true);
  });
});

describe("encodeEvent / parseEventLine", () => {
  it("round-trips every event kind", () => {
    const events = [
      { type: "progress", message: "Coding: task-1 (attempt 1/3)" },
      { type: "finished", status: "done", message: "E2E/QA passed.", logPath: "/runs/x" },
      { type: "crashed", message: "An unexpected error occurred." },
    ] as const;

    for (const event of events) {
      expect(parseEventLine(encodeEvent(event))).toEqual(event);
    }
  });

  it("emits exactly one line per event so a reader can split on newlines", () => {
    const encoded = encodeEvent({ type: "progress", message: "line one\nline two" });
    expect(encoded.endsWith("\n")).toBe(true);
    expect(encoded.trimEnd().includes("\n")).toBe(false);
  });

  it("treats ordinary log output as log output, not as an event", () => {
    expect(parseEventLine("[pipeline] Coding: task-1")).toBeNull();
    expect(parseEventLine("")).toBeNull();
    expect(parseEventLine("{ not json }")).toBeNull();
    expect(parseEventLine('{"type":"progress","message":')).toBeNull();
  });

  it("rejects a well-formed object with a wrong or missing payload rather than half-filling it", () => {
    expect(parseEventLine('{"type":"progress"}')).toBeNull();
    expect(parseEventLine('{"type":"progress","message":42}')).toBeNull();
    expect(parseEventLine('{"type":"finished","message":"ok"}')).toBeNull();
    expect(parseEventLine('{"type":"something-else","message":"ok"}')).toBeNull();
  });

  it("drops a non-string logPath instead of passing it through", () => {
    expect(parseEventLine('{"type":"finished","status":"done","message":"ok","logPath":7}')).toEqual({
      type: "finished",
      status: "done",
      message: "ok",
    });
  });
});

describe("parseEventLine — steps and budget", () => {
  it("reads a step's start, turn and end, keeping only known fields", () => {
    expect(parseEventLine(JSON.stringify({ type: "step", step: "coding:T1", phase: "start" }))).toEqual({
      type: "step",
      step: "coding:T1",
      phase: "start",
    });
    expect(
      parseEventLine(
        JSON.stringify({ type: "step", step: "coding:T1", phase: "turn", turns: 8, maxTurns: 60, note: "soft-cap", extra: 1 }),
      ),
    ).toEqual({ type: "step", step: "coding:T1", phase: "turn", turns: 8, maxTurns: 60, note: "soft-cap" });
    expect(parseEventLine(JSON.stringify({ type: "step", step: "gate:T1", phase: "end", ok: false }))).toEqual({
      type: "step",
      step: "gate:T1",
      phase: "end",
      ok: false,
    });
  });

  it("reads a plan of tasks or port groups", () => {
    const line = JSON.stringify({ type: "step", phase: "plan", group: "coding", items: [{ id: "T1", label: "Login API" }] });
    expect(parseEventLine(line)).toEqual({ type: "step", phase: "plan", group: "coding", items: [{ id: "T1", label: "Login API" }] });
  });

  it("drops a malformed step or plan to log text, and an unknown note", () => {
    expect(parseEventLine(JSON.stringify({ type: "step", phase: "start" }))).toBeNull();
    expect(parseEventLine(JSON.stringify({ type: "step", step: "x", phase: "later" }))).toBeNull();
    expect(parseEventLine(JSON.stringify({ type: "step", phase: "plan", group: "coding", items: [{ id: 1 }] }))).toBeNull();
    expect(parseEventLine(JSON.stringify({ type: "step", phase: "plan", group: "other", items: [] }))).toBeNull();
    expect(parseEventLine(JSON.stringify({ type: "step", step: "x", phase: "turn", note: "panic" }))).toEqual({
      type: "step",
      step: "x",
      phase: "turn",
    });
  });

  it("reads the run's budget cap", () => {
    expect(parseEventLine(JSON.stringify({ type: "budget", capUsd: 12.5 }))).toEqual({ type: "budget", capUsd: 12.5 });
    expect(parseEventLine(JSON.stringify({ type: "budget", capUsd: "12" }))).toBeNull();
  });
});
