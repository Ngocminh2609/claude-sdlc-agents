import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { findFreePorts } from "./free-ports.js";

describe("findFreePorts", () => {
  it("returns the requested number of distinct ports", async () => {
    const ports = await findFreePorts(3);

    expect(ports).toHaveLength(3);
    expect(new Set(ports).size).toBe(3);
    for (const port of ports) {
      expect(port).toBeGreaterThan(0);
      expect(port).toBeLessThanOrEqual(65535);
    }
  });

  it("returns ports that can actually be bound right after", async () => {
    const [port] = await findFreePorts(1);

    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, () => resolve());
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("never hands out a port that is already taken", async () => {
    const busy = createServer();
    await new Promise<void>((resolve) => busy.listen(0, () => resolve()));
    const address = busy.address();
    const busyPort = typeof address === "object" && address ? address.port : -1;

    try {
      const ports = await findFreePorts(5);
      expect(ports).not.toContain(busyPort);
    } finally {
      await new Promise<void>((resolve) => busy.close(() => resolve()));
    }
  });
});
