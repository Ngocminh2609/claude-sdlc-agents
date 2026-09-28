import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkWiring, describeServerApi, describeWiring, portedServerApi, wiringIsSound } from "./clone-wiring.js";
import type { CloneMapping } from "./types.js";

let base: string;
let be: string;
let fe: string;
const roots = () => [
  { role: "be" as const, path: be },
  { role: "fe" as const, path: fe },
];

async function put(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf-8");
}

const CONTROLLER = `package vn.x;
@RestController
@RequestMapping("/stats-indicator")
@Tag(name = "Stats Indicators")
public class StatsIndicatorController {
  @GetMapping("/search")
  public ResponseEntity<?> search() { return null; }
  @PostMapping
  public ResponseEntity<?> add() { return null; }
  @PutMapping(value = "/{id}", produces = "application/json")
  public ResponseEntity<?> edit() { return null; }
  @DeleteMapping("/{id}")
  public ResponseEntity<?> delete() { return null; }
}`;

const PAGE = `import { useState } from 'react';
import { search, add } from '@/services/apis/statsIndicators';
import { columns } from './columns';
export default function Page() { return null; }`;

const CLIENT = `import { request } from "@umijs/max";
const apiPrefix = "/api/meta-registry";
export async function search(params?: any) {
  return request<any>(\`\${apiPrefix}/stats-indicator/search\`, { method: "GET", params });
}
export async function add(body: any) {
  return request<API.Response<API.StatsIndicatorDto>>(\`\${apiPrefix}/stats-indicator\`, { method: "POST", data: body });
}
export async function edit(params: { id: string }, body: any) {
  return request<any>(\`\${apiPrefix}/stats-indicator/\${params.id}\`, { method: "PUT", data: body });
}`;

const mapping: CloneMapping = {
  entries: [
    { source: "a", target: "src/main/java/vn/x/StatsIndicatorController.java", root: "be", group: "BE", changes: "" },
    { source: "b", target: "apps/meta/src/pages/chi-tieu/index.tsx", root: "fe", group: "FE", changes: "" },
    { source: "c", target: "apps/meta/src/pages/chi-tieu/columns.tsx", root: "fe", group: "FE", changes: "" },
  ],
  notes: "",
};

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "aidev-wiring-"));
  be = path.join(base, "be");
  fe = path.join(base, "fe");
  await put(path.join(be, "src/main/java/vn/x/StatsIndicatorController.java"), CONTROLLER);
  await put(path.join(fe, "apps/meta/src/pages/chi-tieu/index.tsx"), PAGE);
  await put(path.join(fe, "apps/meta/src/pages/chi-tieu/columns.tsx"), "export const columns = [];");
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("checkWiring", () => {
  it("flags a page importing an API client nobody wrote — the case that shipped broken", () => {
    const wiring = checkWiring(mapping, roots());

    expect(wiring.unresolvedImports).toEqual([
      { file: "FE: apps/meta/src/pages/chi-tieu/index.tsx", specifier: "@/services/apis/statsIndicators" },
    ]);
    expect(wiringIsSound(wiring)).toBe(false);
  });

  it("passes once the client exists and every call it makes is mapped by a controller", async () => {
    await put(path.join(fe, "apps/meta/src/services/apis/statsIndicators.ts"), CLIENT);

    const wiring = checkWiring(mapping, roots());

    expect(wiring.unresolvedImports).toEqual([]);
    expect(wiring.unmatchedCalls).toEqual([]);
    expect(wiring.callsChecked).toBe(3);
    expect(wiringIsSound(wiring)).toBe(true);
  });

  it("flags a call to a path the server does not map, and one with the wrong method", async () => {
    await put(
      path.join(fe, "apps/meta/src/services/apis/statsIndicators.ts"),
      `${CLIENT}
export async function search2() { return request(\`\${apiPrefix}/stats-indicators/search\`, { method: "GET" }); }
export async function wrong() { return request(\`\${apiPrefix}/stats-indicator\`, { method: "PATCH" }); }`,
    );

    const wiring = checkWiring(mapping, roots());

    expect(wiring.unmatchedCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET ${apiPrefix}/stats-indicators/search",
      "PATCH ${apiPrefix}/stats-indicator",
    ]);
  });

  it("does not check calls when the server folder has no controllers it can read", async () => {
    await rm(path.join(be, "src"), { recursive: true, force: true });
    await put(path.join(fe, "apps/meta/src/services/apis/statsIndicators.ts"), CLIENT);

    const wiring = checkWiring(mapping, roots());

    expect(wiring.endpointsKnown).toBe(0);
    expect(wiring.unmatchedCalls).toEqual([]);
    expect(describeWiring(wiring)).toContain("not checked");
  });

  it("ignores package imports and resolves relative ones with or without an extension", async () => {
    await put(path.join(fe, "apps/meta/src/services/apis/statsIndicators.ts"), CLIENT);
    const wiring = checkWiring(mapping, roots());
    expect(wiring.unresolvedImports.map((miss) => miss.specifier)).not.toContain("react");
    expect(wiring.unresolvedImports.map((miss) => miss.specifier)).not.toContain("./columns");
  });

  it("reads the ported server's API with handler names and @Tag, for the client port", () => {
    const api = describeServerApi(portedServerApi(mapping, roots()));

    expect(api).toHaveLength(4);
    expect(api[0]).toContain('GET /stats-indicator/search -> StatsIndicatorController.search [@Tag "Stats Indicators"]');
    expect(api.some((line) => line.includes("PUT /stats-indicator/{id} -> StatsIndicatorController.edit"))).toBe(true);
  });

  it("reads NestJS and Express servers too", async () => {
    await rm(path.join(be, "src"), { recursive: true, force: true });
    await put(
      path.join(be, "src/stats.controller.ts"),
      `@Controller('stats-indicator')
export class StatsController {
  @Get('search') search() {}
  @Post() add() {}
}`,
    );
    await put(path.join(be, "src/routes.js"), "router.put('/stats-indicator/:id', handler);");
    await put(path.join(fe, "apps/meta/src/services/apis/statsIndicators.ts"), CLIENT);

    const wiring = checkWiring(mapping, roots());

    expect(wiring.unmatchedCalls).toEqual([]);
    expect(wiring.callsChecked).toBe(3);
  });
});
