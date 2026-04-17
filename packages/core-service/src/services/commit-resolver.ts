import type { Pool } from "pg";

export type ResolveCommitError =
  | { code: "invalid_repo"; status: 400; detail: string }
  | { code: "repo_not_found"; status: 404; detail: string }
  | { code: "index_not_found"; status: 404; detail: string };

export interface ResolvedIndex {
  repoId: string;
  indexId: string;
  commitSha: string;
  sourceBlobKey: string | null;
  defaultBranch: string;
}

export type ResolveCommitResult =
  | { ok: true; value: ResolvedIndex }
  | { ok: false; error: ResolveCommitError };

export function parseRepo(repo: string): { org: string; name: string } | null {
  const slash = repo.indexOf("/");
  if (slash === -1) return null;
  const org = repo.slice(0, slash);
  const name = repo.slice(slash + 1);
  if (!org || !name) return null;
  return { org, name };
}

export async function resolveCommit(
  pool: Pool,
  args: { org: string; name: string; commit: string | undefined }
): Promise<ResolveCommitResult> {
  const { org, name, commit } = args;

  const repoRes = await pool.query<{ id: string; default_branch: string }>(
    `SELECT id, default_branch FROM repos WHERE org = $1 AND name = $2`,
    [org, name]
  );
  if (repoRes.rows.length === 0) {
    return {
      ok: false,
      error: { code: "repo_not_found", status: 404, detail: `Repo not found: ${org}/${name}` },
    };
  }
  const { id: repoId, default_branch: defaultBranch } = repoRes.rows[0]!;

  if (commit) {
    const ixRes = await pool.query<{
      id: string;
      commit_sha: string;
      source_blob_key: string | null;
    }>(
      `SELECT id, commit_sha, source_blob_key
       FROM indexes
       WHERE repo_id = $1 AND commit_sha = $2 AND status = 'ready'
       LIMIT 1`,
      [repoId, commit]
    );
    if (ixRes.rows.length === 0) {
      return {
        ok: false,
        error: {
          code: "index_not_found",
          status: 404,
          detail: `No ready index for ${org}/${name}@${commit}`,
        },
      };
    }
    const row = ixRes.rows[0]!;
    return {
      ok: true,
      value: {
        repoId,
        indexId: row.id,
        commitSha: row.commit_sha,
        sourceBlobKey: row.source_blob_key,
        defaultBranch,
      },
    };
  }

  // commit omitted: resolve via repo_head(default_branch)
  const headRes = await pool.query<{
    id: string;
    commit_sha: string;
    source_blob_key: string | null;
  }>(
    `SELECT i.id, i.commit_sha, i.source_blob_key
     FROM repo_head rh
     JOIN indexes i ON i.id = rh.index_id AND i.status = 'ready'
     WHERE rh.repo_id = $1 AND rh.branch = $2
     LIMIT 1`,
    [repoId, defaultBranch]
  );
  if (headRes.rows.length === 0) {
    return {
      ok: false,
      error: {
        code: "index_not_found",
        status: 404,
        detail: `No ready index for ${org}/${name} on default branch '${defaultBranch}'`,
      },
    };
  }
  const row = headRes.rows[0]!;
  return {
    ok: true,
    value: {
      repoId,
      indexId: row.id,
      commitSha: row.commit_sha,
      sourceBlobKey: row.source_blob_key,
      defaultBranch,
    },
  };
}
