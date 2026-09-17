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
