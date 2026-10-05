import { splitGoBatches } from "./sql-safety.js";
import { StageError } from "./stage-error.js";

/**
 * The database a feature run creates its tables in, worked out from the
 * connection string the user gave — URL (`postgres://…`), JDBC
 * (`jdbc:sqlserver://…;databaseName=…`) or ADO (`Server=…;Database=…`).
 *
 * The parsed target holds the password because the driver needs it. Nothing
 * built from it for a prompt, a log or a checkpoint may: `describeDatabase`
 * is the only text form, and it leaves credentials out.
 */

export type SqlDialect = "postgresql" | "sqlserver" | "mysql" | "oracle";

export const DIALECT_NAME: Record<SqlDialect, string> = {
  postgresql: "PostgreSQL",
  sqlserver: "SQL Server",
  mysql: "MySQL",
  oracle: "Oracle",
};

/** Dialects the pipeline can run scripts against. Oracle is recognised so the refusal can say so plainly. */
const RUNNABLE: SqlDialect[] = ["postgresql", "sqlserver", "mysql"];

export interface DatabaseTarget {
  dialect: SqlDialect;
  host: string;
  port?: number;
  /** SQL Server named instance (`host\INSTANCE`). */
  instance?: string;
  database?: string;
  user?: string;
  password?: string;
  /** Remaining connection options, keys lower-cased. */
  options: Record<string, string>;
}

/** A connection that runs one script at a time, each in its own transaction. */
export interface SqlRunner {
  runScript(sql: string): Promise<void>;
  close(): Promise<void>;
}

const URL_SCHEME: Record<string, SqlDialect> = {
  postgres: "postgresql",
  postgresql: "postgresql",
  sqlserver: "sqlserver",
  mssql: "sqlserver",
  mysql: "mysql",
  mariadb: "mysql",
};

export function parseConnection(raw: string): DatabaseTarget {
  const text = raw.trim();
  const unrecognised = () =>
    new StageError(
      "Database: the connection string is not one this tool recognises. Use a URL (postgresql://user:pass@host:5432/db, sqlserver://…, mysql://…), a JDBC URL, or a SQL Server ADO string (Server=…;Database=…;User Id=…;Password=…).",
    );
  const noJdbc = text.replace(/^jdbc:/i, "");

  if (/^oracle:/i.test(noJdbc)) return { dialect: "oracle", host: "", options: {} };

  // SQL Server's JDBC form: sqlserver://host[\instance][:port];key=value;…
  const jdbcSqlServer = /^sqlserver:\/\/([^;]*)(;.*)?$/i.exec(noJdbc);
  if (jdbcSqlServer && !/[@/]/.test(jdbcSqlServer[1])) {
    const options = keyValues(jdbcSqlServer[2] ?? "");
    const [hostPart, portPart] = jdbcSqlServer[1].split(":");
    return sqlServerTarget(hostPart, portPart ?? options.port, options);
  }

  // ADO: Server=host,port;Database=…;User Id=…;Password=…
  if (!noJdbc.includes("://") && /=/.test(noJdbc)) {
    const options = keyValues(noJdbc);
    const server = options.server ?? options["data source"] ?? options.address ?? options.addr;
    if (!server) throw unrecognised();
    const [hostPart, portPart] = server.replace(/^tcp:/i, "").split(",");
    return sqlServerTarget(hostPart, portPart ?? options.port, options);
  }

  let url: URL;
  try {
    url = new URL(noJdbc);
  } catch {
    throw unrecognised();
  }
  const dialect = URL_SCHEME[url.protocol.replace(/:$/, "").toLowerCase()];
  if (!dialect) throw unrecognised();

  const options: Record<string, string> = {};
  url.searchParams.forEach((value, key) => (options[key.toLowerCase()] = value));
  const target: DatabaseTarget = {
    dialect,
    host: decodeURIComponent(url.hostname),
    port: url.port ? Number(url.port) : undefined,
    database: decodeURIComponent(url.pathname.replace(/^\//, "")) || options.database || options.databasename,
    // JDBC URLs usually carry credentials as ?user=…&password=… rather than in the authority.
    user: url.username ? decodeURIComponent(url.username) : options.user,
    password: url.password ? decodeURIComponent(url.password) : options.password,
    options,
  };
  if (dialect === "sqlserver") Object.assign(target, splitInstance(target.host));
  return target;
}

function sqlServerTarget(hostPart: string, port: string | undefined, options: Record<string, string>): DatabaseTarget {
  return {
    dialect: "sqlserver",
    ...splitInstance(hostPart.trim()),
    port: port ? Number(port) : undefined,
    database: options.database ?? options.databasename ?? options["initial catalog"],
    user: options["user id"] ?? options.uid ?? options.user ?? options.username,
    password: options.password ?? options.pwd,
    options,
  };
}

function splitInstance(host: string): { host: string; instance?: string } {
  const [name, instance] = host.split("\\");
  return instance ? { host: name, instance } : { host: name };
}

/** `key=value;key=value`, keys lower-cased. */
function keyValues(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of text.split(";")) {
    const at = pair.indexOf("=");
    if (at > 0) result[pair.slice(0, at).trim().toLowerCase()] = pair.slice(at + 1).trim();
  }
  return result;
}

/** Engine, host and database — never the user's password. Safe for prompts, logs and the UI. */
export function describeDatabase(target: DatabaseTarget): string {
  const host = [target.host, target.instance].filter(Boolean).join("\\");
  const where = `${host}${target.port ? `:${target.port}` : ""}${target.database ? `/${target.database}` : ""}`;
  return `${DIALECT_NAME[target.dialect]}${where ? ` at ${where}` : ""}`;
}

/** Connects with the driver for the target's dialect. Throws a StageError the user can act on. */
export async function connectDatabase(target: DatabaseTarget): Promise<SqlRunner> {
  if (!RUNNABLE.includes(target.dialect)) {
    throw new StageError(
      `Database: running scripts against ${DIALECT_NAME[target.dialect]} is not supported (supported: ${RUNNABLE.map((d) => DIALECT_NAME[d]).join(", ")}). Leave the connection out and apply the scripts yourself.`,
    );
  }
  switch (target.dialect) {
    case "postgresql":
      return connectPostgres(target);
    case "sqlserver":
      return connectSqlServer(target);
    default:
      return connectMySql(target);
  }
}

async function connectPostgres(target: DatabaseTarget): Promise<SqlRunner> {
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
  return {
    // A multi-statement script goes in one simple-protocol query; PostgreSQL DDL is transactional,
    // so a failing script leaves nothing behind.
    async runScript(sql) {
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }
    },
    close: () => client.end(),
  };
}

async function connectSqlServer(target: DatabaseTarget): Promise<SqlRunner> {
  const { default: mssql } = await import("mssql");
  const pool = await new mssql.ConnectionPool({
    server: target.host,
    port: target.port,
    database: target.database,
    user: target.user,
    password: target.password,
    options: {
      instanceName: target.instance,
      encrypt: target.options.encrypt === "true" || target.options.encrypt === "yes",
      // Local and intranet servers mostly run self-signed certificates.
      trustServerCertificate: true,
    },
  }).connect();
  return {
    async runScript(sql) {
      const transaction = new mssql.Transaction(pool);
      await transaction.begin();
      try {
        for (const batch of splitGoBatches(sql)) await new mssql.Request(transaction).batch(batch);
        await transaction.commit();
      } catch (error) {
        await transaction.rollback().catch(() => {});
        throw error;
      }
    },
    close: () => pool.close(),
  };
}

async function connectMySql(target: DatabaseTarget): Promise<SqlRunner> {
  const mysql = await import("mysql2/promise");
  const connection = await mysql.createConnection({
    host: target.host,
    port: target.port,
    database: target.database,
    user: target.user,
    password: target.password,
    multipleStatements: true,
  });
  return {
    // MySQL commits DDL implicitly: a failing CREATE script can leave the
    // tables before the failure in place. Only row changes roll back.
    async runScript(sql) {
      await connection.beginTransaction();
      try {
        await connection.query(sql);
        await connection.commit();
      } catch (error) {
        await connection.rollback().catch(() => {});
        throw error;
      }
    },
    close: () => connection.end(),
  };
}
