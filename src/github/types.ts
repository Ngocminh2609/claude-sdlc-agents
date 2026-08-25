export interface GithubAdapter {
  postComment(issueNumber: number, body: string): Promise<void>;
}
