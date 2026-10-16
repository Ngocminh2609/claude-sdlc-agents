import { splitGoBatches } from "./sql-safety.js";
import { StageError } from "./stage-error.js";
import { DIALECT_NAME, type DatabaseTarget, type SqlDialect } from "./database.js";

/**
 * Read-only use of a TEST database by `aidev sql-optimize`: what the tables
 * really look like, and what the code really returns.
 *
 * `runRolledBack` runs everything inside one transaction that is always
 * rolled back — the procedure definitions (CREATE OR ALTER) and every test
 * call — so the database is left as it was. That holds where DDL is
 * transactional (SQL Server, PostgreSQL). It does not undo what lives outside
 * the transaction: identity/sequence values consumed, mail sent, linked-server
 * calls. Hence: a test database only, never production.
 */

/** One result set: rows as arrays of normalized values (dates as ISO text, binaries as hex). */
export type ResultSet = unknown[][];

export interface CallRun {
  resultSets: ResultSet[];
  /** Wall time of each repetition, ms. */
  ms: number[];
  error?: string;
}

export interface ProbeRun {
  /** The definitions (or the file itself) failed to run: nothing to compare. */
  setupError?: string;
  calls: CallRun[];
}

export interface SqlProbe {
  dialect: SqlDialect;
  /** Columns (type, NULL or NOT NULL) and existing indexes of these tables, as prompt text. */
  describeTables(tables: string[]): Promise<string>;
  runRolledBack(setup: string, calls: string[], repeats: number): Promise<ProbeRun>;
  close(): Promise<void>;
}

const CALL_TIMEOUT_MS = 60_000;

export async function openProbe(target: DatabaseTarget): Promise<SqlProbe> {
  switch (target.dialect) {
    case "postgresql":
      return postgresProbe(target);
    case "sqlserver":
      return sqlServerProbe(target);
    case "mysql":
      return mySqlProbe(target);
    default:
      throw new StageError(`SQL verify: ${DIALECT_NAME[target.dialect]} is not supported (SQL Server, PostgreSQL, MySQL).`);
  }
}

export function normalizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `0x${value.toString("hex")}`;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function timed<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await work();
  return { value, ms: Math.round((performance.now() - started) * 10) / 10 };
}

/** Repeats each call; the first run's result sets are the ones compared, every run is timed. */
async function runCalls(calls: string[], repeats: number, execute: (sql: string) => Promise<ResultSet[]>): Promise<CallRun[]> {
  const runs: CallRun[] = [];
  for (const call of calls) {
    const run: CallRun = { resultSets: [], ms: [] };
    for (let i = 0; i < Math.max(1, repeats); i++) {
      try {
        const { value, ms } = await timed(() => execute(call));
        if (i === 0) run.resultSets = value;
        run.ms.push(ms);
      } catch (error) {
        run.error = errorText(error);
        break;
      }
    }
    runs.push(run);
  }
  return runs;
}

const lowerList = (tables: string[]) => [...new Set(tables.map((table) => table.toLowerCase()))];

function renderSchema(columns: { table: string; column: string; type: string; nullable: boolean }[], indexes: { table: string; text: string }[]): string {
  const tables = [...new Set(columns.map((column) => column.table))];
  return tables
    .map((table) => {
      const cols = columns
        .filter((column) => column.table === table)
        .map((column) => `${column.column} ${column.type}${column.nullable ? " NULL" : " NOT NULL"}`)
        .join(", ");
      const idx = indexes.filter((index) => index.table.toLowerCase() === table.toLowerCase()).map((index) => index.text);
      return `${table}(${cols})${idx.length ? `\n  indexes: ${idx.join("; ")}` : "\n  indexes: none"}`;
    })
    .join("\n");
}

async function postgresProbe(target: DatabaseTarget): Promise<SqlProbe> {
  const { default: pg } = await import("pg");
  const sslMode = target.options.sslmode ?? (target.options.ssl === "true" ? "require" : undefined);
  const client = new pg.Client({
    host: target.host,
    port: target.port,
    database: target.database,
    user: target.user,
    password: target.password,
    ssl: sslMode && sslMode !== "disable" ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  const execute = async (sql: string): Promise<ResultSet[]> => {
    const raw = (await client.query({ text: sql, rowMode: "array" } as never)) as unknown;
    const results = (Array.isArray(raw) ? raw : [raw]) as { fields?: unknown[]; rows: unknown[][] }[];
    return results.filter((result) => result.fields?.length).map((result) => result.rows.map((row) => row.map(normalizeValue)));
  };
  return {
    dialect: "postgresql",
    async describeTables(tables) {
      if (!tables.length) return "";
      const names = lowerList(tables);
      const columns = await client.query(
        `SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
         WHERE lower(table_name) = ANY($1) AND table_schema NOT IN ('pg_catalog','information_schema')
         ORDER BY table_name, ordinal_position`,
        [names],
      );
      const indexes = await client.query(`SELECT tablename, indexdef FROM pg_indexes WHERE lower(tablename) = ANY($1)`, [names]);
      return renderSchema(
        columns.rows.map((row) => ({ table: row.table_name, column: row.column_name, type: row.data_type, nullable: row.is_nullable === "YES" })),
        indexes.rows.map((row) => ({ table: row.tablename, text: row.indexdef })),
      );
    },
    async runRolledBack(setup, calls, repeats) {
      await client.query("BEGIN");
      try {
        await client.query(`SET LOCAL statement_timeout = ${CALL_TIMEOUT_MS}`);
        if (setup.trim()) {
          try {
            await client.query(setup);
          } catch (error) {
            return { setupError: errorText(error), calls: [] };
          }
        }
        // A failed statement aborts a PostgreSQL transaction: each call gets a savepoint.
        return {
          calls: await runCalls(calls, repeats, async (sql) => {
            await client.query("SAVEPOINT aidev_call");
            try {
              const sets = await execute(sql);
              await client.query("RELEASE SAVEPOINT aidev_call");
              return sets;
            } catch (error) {
              await client.query("ROLLBACK TO SAVEPOINT aidev_call");
              throw error;
            }
          }),
        };
      } finally {
        await client.query("ROLLBACK").catch(() => {});
      }
    },
    close: () => client.end(),
  };
}

async function sqlServerProbe(target: DatabaseTarget): Promise<SqlProbe> {
  const { default: mssql } = await import("mssql");
  const pool = await new mssql.ConnectionPool({
    server: target.host,
    port: target.port,
    database: target.database,
    user: target.user,
    password: target.password,
    requestTimeout: CALL_TIMEOUT_MS,
    options: {
      instanceName: target.instance,
      encrypt: target.options.encrypt === "true" || target.options.encrypt === "yes",
      trustServerCertificate: true,
    },
  }).connect();
  return {
    dialect: "sqlserver",
    async describeTables(tables) {
      if (!tables.length) return "";
      const names = lowerList(tables);
      const params = names.map((_, i) => `@t${i}`).join(", ");
      const withNames = () => {
        const request = pool.request();
        names.forEach((name, i) => request.input(`t${i}`, name));
        return request;
      };
      const columns = await withNames().query(
        `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS
         WHERE LOWER(TABLE_NAME) IN (${params}) ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      );
      const indexes = await withNames().query(
        `SELECT t.name AS table_name, i.name AS index_name, i.is_unique, i.type_desc, c.name AS column_name, ic.is_included_column, ic.key_ordinal
         FROM sys.indexes i JOIN sys.tables t ON t.object_id = i.object_id
         JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
         JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
         WHERE LOWER(t.name) IN (${params}) AND i.type > 0 ORDER BY t.name, i.name, ic.is_included_column, ic.key_ordinal`,
      );
      const grouped = new Map<string, { table: string; name: string; unique: boolean; type: string; keys: string[]; include: string[] }>();
      for (const row of indexes.recordset) {
        const key = `${row.table_name}.${row.index_name}`;
        const entry = grouped.get(key) ?? { table: row.table_name, name: row.index_name, unique: row.is_unique, type: row.type_desc, keys: [], include: [] };
        (row.is_included_column ? entry.include : entry.keys).push(row.column_name);
        grouped.set(key, entry);
      }
      return renderSchema(
        columns.recordset.map((row) => ({
          table: row.TABLE_NAME,
          column: row.COLUMN_NAME,
          type: row.CHARACTER_MAXIMUM_LENGTH ? `${row.DATA_TYPE}(${row.CHARACTER_MAXIMUM_LENGTH === -1 ? "max" : row.CHARACTER_MAXIMUM_LENGTH})` : row.DATA_TYPE,
          nullable: row.IS_NULLABLE === "YES",
        })),
        [...grouped.values()].map((index) => ({
          table: index.table,
          text: `${index.name} ${index.type.toLowerCase()}${index.unique ? " unique" : ""} (${index.keys.join(", ")})${index.include.length ? ` include (${index.include.join(", ")})` : ""}`,
        })),
      );
    },
    async runRolledBack(setup, calls, repeats) {
      const transaction = new mssql.Transaction(pool);
      await transaction.begin();
      try {
        try {
          for (const batch of splitGoBatches(setup)) if (batch.trim()) await new mssql.Request(transaction).batch(batch);
        } catch (error) {
          return { setupError: errorText(error), calls: [] };
        }
        return {
          calls: await runCalls(calls, repeats, async (sql) => {
            const sets: ResultSet[] = [];
            for (const batch of splitGoBatches(sql)) {
              if (!batch.trim()) continue;
              const request = new mssql.Request(transaction);
              (request as unknown as { arrayRowMode: boolean }).arrayRowMode = true;
              const result = await request.query(batch);
              for (const set of (result.recordsets ?? []) as unknown as unknown[][][]) {
                sets.push(set.map((row) => row.map(normalizeValue)));
              }
            }
            return sets;
          }),
        };
      } finally {
        await transaction.rollback().catch(() => {});
      }
    },
    close: () => pool.close(),
  };
}

async function mySqlProbe(target: DatabaseTarget): Promise<SqlProbe> {
  const mysql = await import("mysql2/promise");
  const connection = await mysql.createConnection({
    host: target.host,
    port: target.port,
    database: target.database,
    user: target.user,
    password: target.password,
    multipleStatements: true,
    rowsAsArray: true,
  });
  return {
    dialect: "mysql",
    async describeTables(tables) {
      if (!tables.length) return "";
      const names = lowerList(tables);
      const [columns] = (await connection.query({
        sql: `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE FROM information_schema.columns
              WHERE table_schema = DATABASE() AND LOWER(TABLE_NAME) IN (?) ORDER BY TABLE_NAME, ORDINAL_POSITION`,
        values: [names],
        rowsAsArray: false,
      })) as unknown as [Record<string, string>[]];
      const [indexes] = (await connection.query({
        sql: `SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS COLS
              FROM information_schema.statistics WHERE table_schema = DATABASE() AND LOWER(TABLE_NAME) IN (?)
              GROUP BY TABLE_NAME, INDEX_NAME, NON_UNIQUE`,
        values: [names],
        rowsAsArray: false,
      })) as unknown as [Record<string, string | number>[]];
      return renderSchema(
        columns.map((row) => ({ table: row.TABLE_NAME, column: row.COLUMN_NAME, type: row.COLUMN_TYPE, nullable: row.IS_NULLABLE === "YES" })),
        indexes.map((row) => ({
          table: String(row.TABLE_NAME),
          text: `${row.INDEX_NAME}${Number(row.NON_UNIQUE) === 0 ? " unique" : ""} (${row.COLS})`,
        })),
      );
    },
    async runRolledBack() {
      // MySQL commits DDL implicitly: defining the procedures would change the database for real.
      throw new StageError(
        "SQL verify: MySQL commits CREATE/ALTER at once, so a rolled-back test run is not possible there. The schema was still read; results were not compared.",
      );
    },
    close: () => connection.end(),
  };
}
