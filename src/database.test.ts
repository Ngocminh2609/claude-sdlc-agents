import { describe, expect, it } from "vitest";
import { connectDatabase, describeDatabase, parseConnection } from "./database.js";

describe("parseConnection", () => {
  it("reads a PostgreSQL URL", () => {
    expect(parseConnection("postgresql://app:s%40cret@10.0.0.5:5432/CSDLVIMO?sslmode=disable")).toMatchObject({
      dialect: "postgresql",
      host: "10.0.0.5",
      port: 5432,
      database: "CSDLVIMO",
      user: "app",
      password: "s@cret",
      options: { sslmode: "disable" },
    });
  });

  it("reads a PostgreSQL JDBC URL with credentials as query parameters", () => {
    expect(parseConnection("jdbc:postgresql://db.local:5433/app?user=u&password=p")).toMatchObject({
      dialect: "postgresql",
      host: "db.local",
      port: 5433,
      database: "app",
      user: "u",
      password: "p",
    });
  });

  it("reads SQL Server JDBC and ADO forms, including a named instance", () => {
    expect(parseConnection("jdbc:sqlserver://sql01:1433;databaseName=TKDT;user=sa;password=p;encrypt=false")).toMatchObject({
      dialect: "sqlserver",
      host: "sql01",
      port: 1433,
      database: "TKDT",
      user: "sa",
      password: "p",
    });
    expect(parseConnection("Server=sql01\\SQLEXPRESS,1444;Database=TKDT;User Id=sa;Password=p;")).toMatchObject({
      dialect: "sqlserver",
      host: "sql01",
      instance: "SQLEXPRESS",
      port: 1444,
      database: "TKDT",
      user: "sa",
    });
    expect(parseConnection("mssql://sa:p@sql01:1433/TKDT")).toMatchObject({ dialect: "sqlserver", database: "TKDT" });
  });

  it("reads MySQL, and recognises Oracle", () => {
    expect(parseConnection("mysql://root:p@localhost:3306/shop")).toMatchObject({ dialect: "mysql", database: "shop" });
    expect(parseConnection("jdbc:oracle:thin:@db:1521/ORCL").dialect).toBe("oracle");
  });

  it("refuses a string it cannot place, with a message the user can act on", () => {
    expect(() => parseConnection("just some text")).toThrow(/not one this tool recognises/);
    expect(() => parseConnection("redis://localhost")).toThrow(/not one this tool recognises/);
  });
});

describe("describeDatabase", () => {
  it("names engine, host and database without the credentials", () => {
    const text = describeDatabase(parseConnection("postgresql://app:topsecret@10.0.0.5:5432/CSDLVIMO"));
    expect(text).toBe("PostgreSQL at 10.0.0.5:5432/CSDLVIMO");
    expect(text).not.toContain("topsecret");
    expect(text).not.toContain("app");
  });
});

describe("connectDatabase", () => {
  it("says plainly that Oracle scripts are not run, before trying to connect", async () => {
    await expect(connectDatabase(parseConnection("jdbc:oracle:thin:@db:1521/ORCL"))).rejects.toThrow(
      /Oracle is not supported/,
    );
  });
});
