import { createOctokitAdapter } from "./octokit-adapter.js";
import { createDryRunAdapter } from "./dry-run-adapter.js";
import type { GithubAdapter } from "./types.js";

export type { GithubAdapter } from "./types.js";

export function getGithubAdapter(opts: {
  dryRun: boolean;
  repoFullName?: string;
  token?: string;
}): GithubAdapter {
  if (opts.dryRun || !opts.repoFullName || !opts.token) {
    return createDryRunAdapter();
  }
  return createOctokitAdapter(opts.repoFullName, opts.token);
}
