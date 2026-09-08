import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { runPipeline } from "./pipeline.js";
import { RunLogger } from "./run-log.js";
import type { DbInfo, SpecInput } from "./types.js";

interface Args {
  specPath: string;
  projectPath: string;
  dbInfo?: DbInfo;
}

function parseArgs(argv: string[]): Args {
  let specPath: string | undefined;
  let projectPath: string | undefined;
  let dbInfo: DbInfo | undefined;

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--spec":
        specPath = argv[++i];
        break;
      case "--project":
        projectPath = argv[++i];
        break;
      case "--db-connection":
        dbInfo = { kind: "connection", value: argv[++i] };
        break;
      case "--db-schema":
        dbInfo = { kind: "schema-file", value: argv[++i] };
        break;
    }
  }

  if (!specPath || !projectPath) {
    throw new Error(
      "Usage: aidev --spec <path.md> --project <path> [--db-connection <string> | --db-schema <path>]",
    );
  }

  return { specPath, projectPath, dbInfo };
}

async function loadSpec(args: Args): Promise<SpecInput> {
  const specMarkdown = await readFile(args.specPath, "utf-8");
  const projectPath = path.resolve(args.projectPath);

  let dbInfo = args.dbInfo;
  if (dbInfo?.kind === "schema-file") {
    const schemaContent = await readFile(dbInfo.value, "utf-8");
    dbInfo = { kind: "schema-file", value: schemaContent };
  }

  return { specMarkdown, projectPath, dbInfo };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const spec = await loadSpec(args);
  const logger = new RunLogger(spec, args.specPath);

  process.chdir(spec.projectPath);

  const result = await runPipeline({
    spec,
    logger,
    onProgress: (message) => console.log(`[pipeline] ${message}`),
  });

  console.log(`\nPipeline finished with status: ${result.status}`);
  console.log(result.message);
  if (result.logPath) {
    console.log(`\nFull run log: ${result.logPath}`);
  }

  if (result.status !== "done") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("Pipeline crashed:", error);
  process.exitCode = 1;
});
