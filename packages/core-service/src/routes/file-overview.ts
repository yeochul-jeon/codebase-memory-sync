import type { FastifyInstance } from "fastify";
import { getPool } from "../storage/postgres.js";
import { parseRepo, resolveCommit } from "../services/commit-resolver.js";

export async function fileOverviewRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: {
      repo?: string;
      file_path?: string;
      commit?: string;
      branch?: string;
    };
  }>("/v1/files/overview", async (request, reply) => {
    const { repo, file_path, commit, branch } = request.query;

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

    const parsed = parseRepo(repo.trim());
    if (!parsed) {
      return reply.status(400).send({
        error: "invalid_repo",
        detail: "repo must be in 'org/name' format",
      });
    }
    const { org, name } = parsed;

    const pool = getPool();
    const r = await resolveCommit(pool, { org, name, commit, ...(branch !== undefined ? { branch } : {}) });
    if (!r.ok) {
      return reply.status(r.error.status).send({ error: r.error.code, detail: r.error.detail });
    }
    const { indexId, commitSha } = r.value;

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
        detail: `No symbols indexed for ${file_path} in ${org}/${name}`,
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
