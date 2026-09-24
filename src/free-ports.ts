import { createServer } from "node:net";

/**
 * Asks the OS for `count` TCP ports that are free right now, so the stages
 * that start the target app (Coding, E2E) are handed working ports instead of
 * guessing a default. A machine running other projects routinely has 8080,
 * 3000 or 5173 taken — a real run failed exactly that way, with the E2E stage
 * burning its whole turn budget trying to start a backend on a busy port.
 *
 * Listening on port 0 with no host binds the dual-stack wildcard, so a port
 * the OS hands back is free on IPv4 and IPv6 alike. All servers are held open
 * until every port is chosen, so one call never returns the same port twice.
 * "Free now" is not "free forever" — the prompt still tells the agent to pick
 * another port on "address already in use" rather than treating these as
 * guaranteed.
 */
export async function findFreePorts(count: number): Promise<number[]> {
  const servers = await Promise.all(
    Array.from({ length: count }, () => {
      const server = createServer();
      return new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, () => resolve(server));
      });
    }),
  );

  const ports = servers.map((server) => {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("OS returned no TCP port for an ephemeral listen");
    }
    return address.port;
  });

  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  return ports;
}
