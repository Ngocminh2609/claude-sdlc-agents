/**
 * Formats a duration given in milliseconds into a human-readable string.
 *
 * - < 1000ms   -> "{ms}ms"
 * - < 60000ms  -> "{seconds with 1 decimal}s"
 * - >= 60000ms -> "{minutes}m {seconds}s"
 *
 * Minutes and seconds (for the >= 60000ms branch) are derived from a single
 * rounded total-seconds value, not rounded independently. Rounding each unit
 * separately can overflow (e.g. 119500ms -> "1m 60s"); deriving both from one
 * rounded total avoids that by construction (119500ms -> totalSeconds 120 ->
 * "2m 0s").
 *
 * Non-goal: non-integer `ms` in the < 1000ms branch (e.g. 500.7) is not
 * rounded/truncated — it is interpolated as-is ("500.7ms"). This is a
 * deliberate choice, not an oversight, absent a spec requirement to round.
 *
 * Non-goal: negative, NaN, or Infinity input is out of scope per the issue.
 * Behavior is unspecified/undefined by design — not validated or guarded
 * against.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const totalSeconds = Math.round(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}m ${s}s`;
}
