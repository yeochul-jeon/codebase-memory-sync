import type { FastifyInstance } from "fastify";
import { getPool } from "../storage/postgres.js";

export async function fileOverviewRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: {
      repo?: string;
      file_path?: string;
      commit?: string;
    };
  }>("/v1/files/overview", async (request, reply) => {
    const { repo, file_path, commit } = request.query;

    if (!repo || repo.trim().length === 0) {
      return reply.status(400).send({
        error: "missing_repo",
        detail: "repo query param is required",
      });
    }

    if (!file_path || file_path.trim().length === 0) {
      return reply.status(400).send({
        error: "missing_file_path",
        detail: "file_path query param is required",
      });
    }

    const parts = repo.trim().split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return reply.status(400).send({
        error: "invalid_repo",
        detail: "repo must be in 'org/name' format",
      });
    }
    const [org, name] = parts as [string, string];

    const pool = getPool();

    // Resolve repo
    const repoRes = await pool.query<{ id: string }>(
      `SELECT id FROM repos WHERE org = $1 AND name = $2`,
      [org, name]
    );
    if (repoRes.rows.length === 0) {
      return reply.status(404).send({
        error: "repo_not_found",
        detail: `Repo not found: ${repo}`,
      });
    }
    const repoId = repoRes.rows[0]!.id;

    // Resolve index: prefer commit-specific, else latest ready
    let indexId: string;
    let commitSha: string;

    if (commit) {
      const ixRes = await pool.query<{ id: string; commit_sha: string }>(
        `SELECT id, commit_sha FROM indexes
         WHERE repo_id = $1 AND commit_sha = $2 AND status = 'ready'
         ORDER BY created_at DESC LIMIT 1`,
        [repoId, commit.trim()]
      );
      if (ixRes.rows.length === 0) {
        return reply.status(404).send({
          error: "index_not_found",
          detail: `No ready index found for ${repo}@${commit}`,
        });
      }
      indexId = ixRes.rows[0]!.id;
      commitSha = ixRes.rows[0]!.commit_sha;
    } else {
      const ixRes = await pool.query<{ id: string; commit_sha: string }>(
        `SELECT i.id, i.commit_sha
         FROM indexes i
         WHERE i.repo_id = $1 AND i.status = 'ready'
         ORDER BY i.created_at DESC LIMIT 1`,
        [repoId]
      );
      if (ixRes.rows.length === 0) {
        return reply.status(404).send({
          error: "index_not_found",
          detail: `No ready index found for ${repo}`,
        });
      }
      indexId = ixRes.rows[0]!.id;
      commitSha = ixRes.rows[0]!.commit_sha;
    }

    // Fetch symbols in the file
    const symRes = await pool.query<{
      scip_symbol: string;
      display_name: string | null;
      kind: string | null;
      language: string | null;
      start_line: number | null;
      start_col: number | null;
      end_line: number | null;
      end_col: number | null;
      signature: string | null;
      doc: string | null;
    }>(
      `SELECT scip_symbol, display_name, kind, language,
              start_line, start_col, end_line, end_col, signature, doc
       FROM symbols
       WHERE index_id = $1 AND file_path = $2
       ORDER BY start_line ASC NULLS LAST, start_col ASC NULLS LAST`,
      [indexId, file_path.trim()]
    );

    if (symRes.rows.length === 0) {
      return reply.status(404).send({
        error: "file_not_indexed",
        detail: `No symbols indexed for ${file_path} in ${repo}`,
      });
    }

    return reply.send({
      repo: `${org}/${name}`,
      commit_sha: commitSha,
      file_path: file_path.trim(),
      total: symRes.rows.length,
      symbols: symRes.rows,
    });
  });
}
