import type { RepoInfo } from "../client.js";
import { shortSha, timeAgo } from "../format.js";

export interface ListProjectsDeps {
  listRepos(): Promise<{ repos: RepoInfo[] }>;
}

export async function handleListProjects(
  deps: ListProjectsDeps
): Promise<{ content: [{ type: "text"; text: string }] }> {
  const { repos } = await deps.listRepos();

  if (repos.length === 0) {
    return { content: [{ type: "text", text: "No projects indexed." }] };
  }

  const lines = repos.map(r => {
    const lang = r.primary_lang ?? "unknown";
    const headsStr =
      r.heads.length === 0
        ? "  heads: (none)"
        : r.heads
            .map(h => `    ${h.branch}@${shortSha(h.commit_sha)} (${timeAgo(h.indexed_at)})`)
            .join("\n");

    return [
      `[${r.org}/${r.name}] lang=${lang}, default_branch=${r.default_branch}`,
      `  heads:`,
      headsStr,
    ].join("\n");
  });

  return { content: [{ type: "text", text: lines.join("\n\n") }] };
}
