import type { IncomingMessage } from "node:http";

/**
 * Keeps other web pages out of the local UI. Binding to 127.0.0.1 stops other
 * machines, not the person's own browser: any page they visit can send it a
 * request, and the UI can start agent runs and browse the disk.
 *
 * - Host must be this server (127.0.0.1 / localhost on its port). A page using
 *   DNS rebinding reaches us under its own host name, so it is refused.
 * - A request that changes something (anything but GET/HEAD) must come from
 *   the UI's own origin, or from no browser at all (no Origin header — curl,
 *   tests), and must be JSON. A cross-site form or `fetch` with a "simple"
 *   content type carries the foreign Origin and is refused; a cross-site JSON
 *   request needs a CORS preflight this server never answers.
 *
 * Returns why the request is refused, or null when it may go through.
 */
export function refusalOf(req: Pick<IncomingMessage, "method" | "headers">, port: number): string | null {
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  const host = (req.headers.host ?? "").toLowerCase();
  if (!allowedHosts.includes(host)) return `unexpected Host header "${host}"`;

  const method = (req.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return null;

  const origin = req.headers.origin;
  if (origin !== undefined && !allowedHosts.some((allowed) => origin.toLowerCase() === `http://${allowed}`)) {
    return `cross-site request from "${origin}"`;
  }
  const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
  if (!contentType.startsWith("application/json")) return "a request that changes something must be JSON";
  return null;
}
