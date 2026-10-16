import { describe, expect, it } from "vitest";
import { refusalOf } from "./request-guard.js";

const req = (method: string, headers: Record<string, string>) => ({ method, headers });

describe("refusalOf", () => {
  it("lets the UI's own page read and act", () => {
    expect(refusalOf(req("GET", { host: "127.0.0.1:4319" }), 4319)).toBeNull();
    expect(refusalOf(req("GET", { host: "localhost:4319" }), 4319)).toBeNull();
    expect(
      refusalOf(req("POST", { host: "127.0.0.1:4319", origin: "http://127.0.0.1:4319", "content-type": "application/json" }), 4319),
    ).toBeNull();
    // No browser involved (curl, scripts): no Origin header.
    expect(refusalOf(req("POST", { host: "127.0.0.1:4319", "content-type": "application/json" }), 4319)).toBeNull();
  });

  it("refuses a page that reached the server through DNS rebinding", () => {
    expect(refusalOf(req("GET", { host: "evil.example:4319" }), 4319)).toMatch(/Host/);
    expect(refusalOf(req("GET", { host: "127.0.0.1:9999" }), 4319)).toMatch(/Host/);
  });

  it("refuses a cross-site request that would start a run", () => {
    expect(
      refusalOf(req("POST", { host: "127.0.0.1:4319", origin: "https://evil.example", "content-type": "application/json" }), 4319),
    ).toMatch(/cross-site/);
    // A form or a "simple" fetch: no preflight, so the content type is what stops it.
    expect(refusalOf(req("POST", { host: "127.0.0.1:4319", "content-type": "text/plain" }), 4319)).toMatch(/JSON/);
    expect(refusalOf(req("POST", { host: "127.0.0.1:4319" }), 4319)).toMatch(/JSON/);
  });
});
