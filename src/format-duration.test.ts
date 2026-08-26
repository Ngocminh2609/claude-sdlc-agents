import { describe, expect, it } from "vitest";
import { formatDuration } from "./format-duration.js";

describe("formatDuration", () => {
  describe("sub-second durations (< 1000ms)", () => {
    it("formats 0ms", () => {
      expect(formatDuration(0)).toBe("0ms");
    });

    it("formats a mid-range millisecond value", () => {
      expect(formatDuration(500)).toBe("500ms");
    });

    it("formats the upper boundary just under 1s", () => {
      expect(formatDuration(999)).toBe("999ms");
    });

    // non-goal: non-integer ms is not rounded/truncated in this branch — it
    // is interpolated as-is. This is a deliberate scope choice, not a bug.
    it("does not round/truncate non-integer ms (deliberate non-goal)", () => {
      expect(formatDuration(500.7)).toBe("500.7ms");
    });
  });

  describe("second-range durations (1000ms <= ms < 60000ms)", () => {
    it("formats exactly 1s", () => {
      expect(formatDuration(1000)).toBe("1.0s");
    });

    it("formats a value with a non-zero decimal", () => {
      expect(formatDuration(1500)).toBe("1.5s");
    });

    // Boundary case: 59999ms rounds to "60.0s" via toFixed(1). This reads as
    // surprising (looks like it should be a minute) but is in-range per the
    // spec (< 60000) and not excluded by acceptance criteria. Asserting the
    // actual computed value locks in the behavior rather than leaving it
    // undefined.
    it("formats the upper boundary just under 60s as 60.0s (locked-in boundary behavior)", () => {
      expect(formatDuration(59999)).toBe("60.0s");
    });
  });

  describe("minute-range durations (>= 60000ms)", () => {
    it("formats exactly 1 minute", () => {
      expect(formatDuration(60000)).toBe("1m 0s");
    });

    it("formats 1 minute 30 seconds", () => {
      expect(formatDuration(90000)).toBe("1m 30s");
    });

    // Regression test: rounding minutes and seconds independently would
    // overflow here (1m 60s). Deriving both from one rounded total-seconds
    // value avoids that: 119500ms -> totalSeconds 120 -> "2m 0s".
    it("does not overflow seconds when rounding pushes the total up a minute", () => {
      expect(formatDuration(119500)).toBe("2m 0s");
    });
  });

  // non-goal: negative, NaN, or Infinity input is out of scope per the
  // issue. Behavior is unspecified/undefined by design — not validated or
  // guarded against, so these are documented here rather than asserted as
  // contractual behavior.
});
