# Feature: Server-backed counter web app

A small Node.js/Express app with a single counter, incremented via a button
in the browser. Count is stored server-side (in memory is fine) so a page
refresh does not reset it.

## Acceptance Criteria
- `npm start` (or `npm run dev`) serves the app on a local port.
- Visiting `/` in a browser shows the text `Count: 0` on first load.
- The page has a button labeled "Increment".
- Clicking "Increment" increases the displayed count by 1, without a full
  page reload (fetch/XHR to a backend endpoint).
- Backend exposes `GET /api/count` returning the current count as JSON
  (e.g. `{ "count": 0 }`).
- Backend exposes `POST /api/increment` that increments the server-side
  count by 1 and returns the new count as JSON.
- Reloading the page after clicking "Increment" a few times still shows the
  incremented count (proves the count is server-side, not just client-side
  state).

## Out of scope
- No persistence across server restarts (in-memory is fine).
- No authentication, no multiple counters, no styling requirements.
