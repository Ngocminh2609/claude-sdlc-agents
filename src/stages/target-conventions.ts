import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { runStructuredQuery } from "../sdk-helpers.js";
import { config } from "../config.js";
import { indexFor, indexPromptSection, withIndexAccess } from "../project-index.js";
import { rootsOf, secondaryRootDirs, targetRootsPromptSection } from "../target-roots.js";
import type { CloneInput, TargetConventions } from "../types.js";

/**
 * Reads the target project and writes down how it is organised, before
 * anything decides where ported code should go.
 *
 * This is the stage that answers "which folder does this belong in", and it
 * answers it from the target's own code rather than from the reference's
 * shape. The two repos this was built for differ in exactly the ways that
 * matter — `com.fpt.common.*` against `vn.gov.tctk.microdata.modules.*`,
 * `BE-X/module-category/` against `BE-Y/modules/category/` — so mirroring the
 * source layout would put every file in a place that does not exist.
 *
 * Read-only: no reference repo access either, because the question here is
 * only about the target.
 */

const SYSTEM_PROMPT = `You are the Target Conventions agent in an automated port pipeline.
Read the target project in the current working directory and describe how it is
organised, so a later stage can decide where ported code belongs.

Cover, for each layer the project actually has:
- Top-level layout: which directory holds server code, client code, database
  scripts, deployment files.
- Server: module layout and how modules are nested, the root package or
  namespace, where controllers/services/repositories/entities/DTOs live within a
  module, how a new module is registered with the build.
- Client: the feature/page folder convention, routing registration, state and
  API-client conventions, where shared components live.
- Database: script folder, file naming and ordering convention, migration tool
  if any — and whether tables are created by the ORM at startup (e.g. Hibernate
  ddl-auto create/update) or only by those scripts (ddl-auto none/validate, or a
  migration tool). Quote the setting and an existing script path; a port that
  adds entities depends on this answer.
- Naming: the casing and suffix conventions actually used for files, classes and
  columns — quote real examples from the code rather than generalising.
- CI/CD: find the project's actual pipeline config (.gitlab-ci.yml,
  .github/workflows/*, Jenkinsfile, azure-pipelines.yml, bitbucket-pipelines.yml)
  and quote the exact build/lint/test commands and flags each job runs, the
  toolchain image/version it's pinned to, and whether it scopes to one
  module/package (e.g. -pl/--filter/-am) rather than the whole tree. Say plainly
  when a stage you'd expect (lint, type-check, unit tests) is disabled, commented
  out, or missing — a later stage needs to know the pipeline will not catch that
  class of error itself. If a Dockerfile drives the pipeline's build, note how it
  registers which modules/packages get built (an explicit COPY or build-list per
  module means a new one must be added there too, not just to the source tree).

Report what the project does, not what it should do. Where the project is
inconsistent, say so and name the dominant pattern. Do not propose changes, do
not design anything, and do not write or edit files.`;

const CONVENTIONS_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
  },
  required: ["summary"],
};

export async function readTargetConventions(clone: CloneInput): Promise<TargetConventions | null> {
  const options: Options = {
    systemPrompt: SYSTEM_PROMPT,
    allowedTools: ["Read", "Glob", "Grep"],
    model: config.model,
    maxTurns: config.maxTurns.targetConventions,
  };

  const roots = rootsOf(clone);
  const secondary = secondaryRootDirs(roots);
  if (secondary.length) options.additionalDirectories = secondary;
  // Only the target's own indexes: this stage is about the target alone.
  const targetIndexes = (clone.projectIndexes ?? []).filter((index) => roots.some((root) => indexFor([index], root.path)));
  withIndexAccess(options, targetIndexes);

  const prompt = [
    "--- What will be ported into this project ---",
    clone.what,
    ...targetRootsPromptSection(roots),
    ...indexPromptSection(targetIndexes),
    "",
    "Describe how this project is organised, with enough precision that another",
    "agent can place new server, client and database files without guessing.",
    ...(secondary.length
      ? ["Cover every target folder listed above, and say which conventions belong to which folder."]
      : []),
  ].join("\n");

  const result = await runStructuredQuery<TargetConventions>(prompt, options, CONVENTIONS_SCHEMA);
  if (!result.ok || !result.data?.summary.trim()) return null;
  return result.data;
}
