# Feature: Duration formatter

## Acceptance Criteria
- A new exported function `formatDuration(ms: number): string` exists
- For `ms < 1000`: returns `"Xms"`
- For `1000 <= ms < 60000`: returns `"Xs"`, rounded to 1 decimal
- For `ms >= 60000`: returns `"Xm Ys"`
- Covered by unit tests for all of the above cases

## Out of scope
- No CLI wiring, no i18n, no support for hours/days
