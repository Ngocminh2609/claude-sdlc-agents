import type { GithubAdapter } from "./types.js";

export function createDryRunAdapter(): GithubAdapter {
  return {
    async postComment(issueNumber: number, body: string): Promise<void> {
      console.log(`\n[dry-run] would comment on issue #${issueNumber}:\n${body}\n`);
    },
  };
}
