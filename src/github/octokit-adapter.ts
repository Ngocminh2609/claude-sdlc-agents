import { Octokit } from "@octokit/rest";
import type { GithubAdapter } from "./types.js";

export function createOctokitAdapter(repoFullName: string, token: string): GithubAdapter {
  const [owner, repo] = repoFullName.split("/");
  const octokit = new Octokit({ auth: token });

  return {
    async postComment(issueNumber: number, body: string): Promise<void> {
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: issueNumber,
        body,
      });
    },
  };
}
