import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { planFileFor, readPlanFile, summarizePlan } from "./sql-plan.js";

const SQLPLAN = `<?xml version="1.0" encoding="utf-16"?>
<ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan" Version="1.564">
 <BatchSequence><Batch><Statements>
  <StmtSimple StatementText="SELECT o.OrderId FROM dbo.Orders o WHERE YEAR(o.OrderDate) = @y AND o.Code = N&apos;A1&apos;" StatementSubTreeCost="12.5">
   <QueryPlan>
    <MissingIndexes>
     <MissingIndexGroup Impact="87.3">
      <MissingIndex Database="[Shop]" Schema="[dbo]" Table="[Orders]">
       <ColumnGroup Usage="EQUALITY"><Column Name="[Code]" ColumnId="4" /></ColumnGroup>
       <ColumnGroup Usage="INCLUDE"><Column Name="[OrderDate]" ColumnId="3" /></ColumnGroup>
      </MissingIndex>
     </MissingIndexGroup>
    </MissingIndexes>
    <Warnings><PlanAffectingConvert ConvertIssue="Seek Plan" Expression="CONVERT_IMPLICIT(nvarchar(20),[o].[Code],0)=N'A1'" /></Warnings>
    <RelOp NodeId="0" PhysicalOp="Nested Loops" LogicalOp="Inner Join" EstimateRows="40" EstimateIO="0" EstimateCPU="0.1" EstimatedTotalSubtreeCost="12.5">
     <RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="6000" /></RunTimeInformation>
     <RelOp NodeId="1" PhysicalOp="Clustered Index Scan" LogicalOp="Clustered Index Scan" EstimateRows="40" EstimateIO="10.2" EstimateCPU="1.9" EstimatedTotalSubtreeCost="12.1">
      <RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="6000" /></RunTimeInformation>
      <IndexScan><Object Database="[Shop]" Schema="[dbo]" Table="[Orders]" Index="[PK_Orders]" /></IndexScan>
     </RelOp>
    </RelOp>
   </QueryPlan>
  </StmtSimple>
 </Statements></Batch></BatchSequence>
</ShowPlanXML>`;

describe("summarizePlan", () => {
  it("reads a SQL Server plan into hotspots, warnings and missing indexes", () => {
    const plan = summarizePlan(SQLPLAN);
    expect(plan).toMatchObject({ format: "sqlserver-xml", dialect: "sqlserver", operators: 2 });
    expect(plan.text).toContain("Statement 1 (cost 12.5, 100% of all): SELECT o.OrderId FROM dbo.Orders o WHERE YEAR(o.OrderDate) = @y AND o.Code = N'A1'");
    const lines = plan.text.split("\n");
    const scan = lines.findIndex((line) => line.startsWith("- Clustered Index Scan on dbo.Orders.PK_Orders"));
    const loops = lines.findIndex((line) => line.startsWith("- Nested Loops"));
    expect(scan).toBeGreaterThan(-1);
    expect(scan).toBeLessThan(loops); // most expensive first
    expect(lines[scan]).toContain("[FULL SCAN]");
    expect(lines[scan]).toContain("[ESTIMATE OFF: est 40 vs actual 6000]");
    expect(plan.text).toContain("Implicit conversion (Seek Plan): CONVERT_IMPLICIT(nvarchar(20),[o].[Code],0)=N'A1'");
    expect(plan.text).toContain("- dbo.Orders (Code) include (OrderDate) — estimated impact 87.3%");
  });

  it("reads a PostgreSQL EXPLAIN ANALYZE JSON plan by each node's own time", () => {
    const json = JSON.stringify([
      {
        Plan: {
          "Node Type": "Hash Join",
          "Total Cost": 900,
          "Plan Rows": 100,
          "Actual Rows": 120,
          "Actual Total Time": 50,
          "Actual Loops": 1,
          Plans: [
            { "Node Type": "Seq Scan", "Relation Name": "orders", "Total Cost": 700, "Plan Rows": 30, "Actual Rows": 6000, "Actual Total Time": 40, "Actual Loops": 1, Filter: "(status = 'PAID')", "Rows Removed by Filter": 1200 },
            { "Node Type": "Index Scan", "Relation Name": "customers", "Index Name": "customers_pkey", "Total Cost": 100, "Plan Rows": 300, "Actual Rows": 300, "Actual Total Time": 4, "Actual Loops": 1 },
          ],
        },
        "Planning Time": 0.4,
        "Execution Time": 51.2,
      },
    ]);
    const plan = summarizePlan(json);
    expect(plan).toMatchObject({ format: "postgresql-json", dialect: "postgresql", operators: 3 });
    expect(plan.text).toContain("Measured plan (EXPLAIN ANALYZE): execution 51.2 ms");
    const first = plan.text.split("\n").find((line) => line.startsWith("- "));
    expect(first).toMatch(/^- Seq Scan on orders: 80% of time, est rows 30, actual 6000 filter \(status = 'PAID'\) \(removed 1200 rows\) \[FULL SCAN\] \[ESTIMATE OFF/);
  });

  it("reads a MySQL EXPLAIN FORMAT=JSON plan", () => {
    const json = JSON.stringify({
      query_block: {
        cost_info: { query_cost: "1210.50" },
        nested_loop: [
          { table: { table_name: "o", access_type: "ALL", rows_examined_per_scan: 6000, filtered: "10.00", attached_condition: "(year(`o`.`order_date`) = 2024)" } },
          { table: { table_name: "c", access_type: "eq_ref", key: "PRIMARY", possible_keys: ["PRIMARY"], rows_examined_per_scan: 1, filtered: "100.00" } },
        ],
      },
    });
    const plan = summarizePlan(json);
    expect(plan).toMatchObject({ format: "mysql-json", dialect: "mysql", operators: 2 });
    expect(plan.text).toContain("- o: access ALL [FULL SCAN], key none, rows examined 6000, filtered 10.00%, condition (year(`o`.`order_date`) = 2024)");
  });

  it("passes a text plan on, marking full scans", () => {
    const plan = summarizePlan("Hash Join  (cost=10..900 rows=100)\n  ->  Seq Scan on orders o  (cost=0..700 rows=30)");
    expect(plan.format).toBe("text");
    expect(plan.text).toContain("Seq Scan on orders o  (cost=0..700 rows=30)   <-- FULL SCAN");
  });
});

describe("plan files", () => {
  it("reads a UTF-16 .sqlplan as SSMS saves it, and matches plans to SQL files by name in a folder", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "aidev-plan-"));
    try {
      const planFile = path.join(dir, "usp_orders.sqlplan");
      await writeFile(planFile, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(SQLPLAN, "utf16le")]));
      expect((await readPlanFile(planFile)).format).toBe("sqlserver-xml");

      expect(planFileFor(dir, path.join("/sql", "usp_orders.sql"))).toBe(planFile);
      expect(planFileFor(dir, path.join("/sql", "other.sql"))).toBeNull();
      expect(planFileFor(planFile, path.join("/sql", "anything.sql"))).toBe(planFile);
      expect(planFileFor(undefined, "/sql/a.sql")).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
