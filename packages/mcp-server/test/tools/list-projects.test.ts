import { describe, it, expect } from "vitest";
import { handleListProjects } from "../../src/tools/list-projects.js";
import type { ListProjectsDeps } from "../../src/tools/list-projects.js";

const mockRepos = [
  {
    id: "r1",
    org: "acme",
    name: "backend",
    default_branch: "main",
    primary_lang: "java",
    created_at: "2024-01-01T00:00:00Z",
    heads: [
      { branch: "main", commit_sha: "abc1234567890", indexed_at: new Date(Date.now() - 5 * 60 * 1000).toISOString() },
    ],
  },
  {
    id: "r2",
    org: "acme",
    name: "frontend",
    default_branch: "main",
    primary_lang: "typescript",
    created_at: "2024-01-02T00:00:00Z",
    heads: [],
  },
];

const mockDeps: ListProjectsDeps = {
  listRepos: async () => ({ repos: mockRepos }),
};

describe("handleListProjects", () => {
  it("returns text content block", async () => {
    const result = await handleListProjects(mockDeps);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe("text");
  });

  it("includes each repo in output", async () => {
    const result = await handleListProjects(mockDeps);
    const text = result.content[0]!.text;
    expect(text).toContain("acme/backend");
    expect(text).toContain("acme/frontend");
  });

  it("shows primary language and default branch", async () => {
    const result = await handleListProjects(mockDeps);
    const text = result.content[0]!.text;
    expect(text).toContain("java");
    expect(text).toContain("main");
  });

  it("shows head commit info for repos that have heads", async () => {
    const result = await handleListProjects(mockDeps);
    const text = result.content[0]!.text;
    expect(text).toContain("abc12345");  // truncated commit sha
    expect(text).toContain("main@");
  });

  it("returns 'No projects indexed.' when repos array is empty", async () => {
    const emptyDeps: ListProjectsDeps = { listRepos: async () => ({ repos: [] }) };
    const result = await handleListProjects(emptyDeps);
    expect(result.content[0]!.text).toBe("No projects indexed.");
  });
});
