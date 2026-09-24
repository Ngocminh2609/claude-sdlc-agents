/**
 * Prompt block for any stage that starts the target app (Coding, E2E).
 *
 * Shared rather than written into each stage, because both stages start the
 * same servers and must follow the same rule: never assume a default port.
 */
export function runtimePortsPromptSection(ports: number[]): string[] {
  if (!ports.length) return [];
  return [
    "",
    "--- Free ports for running the app ---",
    `These TCP ports were checked free on this machine just before your session: ${ports.join(", ")}.`,
    "This machine runs other projects, so a default port (8080, 8081, 3000, 5173, ...) may already be",
    "taken by an unrelated process. Whenever you start a server (backend, frontend dev server, a",
    "Playwright webServer entry):",
    "- Start it on one of the free ports above, passed at run time — an env var or CLI flag such as",
    "  SERVER_PORT / --server.port for Spring Boot, --port for Vite, PORT for Node — and point every",
    "  client (frontend API base URL, Playwright baseURL, test HTTP clients) at that same port.",
    "- Do not change the project's default port in its committed config just to fit this run; make it",
    "  overridable instead, so the project still works on its documented default elsewhere.",
    "- If a server still fails with 'address already in use', move to another free port instead of",
    "  retrying the same one. Never kill a process you did not start to free a port.",
    "- Stop every server you started before you finish, so nothing is left holding a port.",
  ];
}
