import type { FastifyInstance } from "fastify";
import { getPool } from "../storage/postgres.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export async function implementorsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: {
      scip_symbol?: string;
      repo?: string;
      limit?: string;
    };
  }>("/v1/symbols/implementors", async (request, reply) => {
    const { scip_symbol, repo, limit: limitStr } = request.query;

    if (!scip_symbol || scip_symbol.trim().length === 0) {
      return reply.status(400).send({
        error: "missing_scip_symbol",
        detail: "scip_symbol query param is required",
      });
    }

    let limit = DEFAULT_LIMIT;
    if (limitStr !== undefined) {
      const parsed = parseInt(limitStr, 10);
      if (isNaN(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
        return reply.status(400).send({
          error: "invalid_limit",
          detail: `limit must be between 1 and ${MAX_LIMIT}`,
        });
      }
      limit = parsed;
    }

    let org: string | undefined;
    let repoName: string | undefined;
    if (repo !== undefined) {
      const parts = repo.split("/");
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        return reply.status(400).send({
          error: "invalid_repo",
          detail: "repo must be in 'org/name' format",
        });
      }
      org = parts[0];
      repoName = parts[1];
    }

    const sym = scip_symbol.trim();
    const pool = getPool();
    const params: unknown[] = [sym];
    const whereClauses: string[] = [
      "sr.to_symbol = $1",
      "sr.is_implementation = true",
    ];

    if (org && repoName) {
      params.push(org, repoName);
      whereClauses.push(
        `r.org = $${params.length - 1} AND r.name = $${params.length}`
      );
    }

    const where = whereClauses.join(" AND ");

    const countRes = await pool.query<{ total: string }>(
      `SELECT COUNT(*) AS total
       FROM symbol_relationships sr
       JOIN indexes i ON i.id = sr.index_id AND i.status = 'ready'
       JOIN repos r ON r.id = sr.repo_id
       WHERE ${where}`,
      params
    );
    const total = parseInt(countRes.rows[0]!.total, 10);

    if (total === 0) {
      return reply.status(404).send({
        error: "symbol_not_found",
        detail: `No implementors found for symbol: ${sym}`,
      });
    }

    params.push(limit);
    const rows = await pool.query<{
      from_symbol: string;
      display_name: string | null;
      kind: string | null;
      file_path: string | null;
      start_line: number | null;
      repo_org: string;
      repo_name: string;
      commit_sha: string;
    }>(
      `SELECT
         sr.from_symbol,
         s.display_name, s.kind, s.file_path, s.start_line,
         r.org AS repo_org, r.name AS repo_name, sr.commit_sha
       FROM symbol_relationships sr
       LEFT JOIN symbols s
         ON s.scip_symbol = sr.from_symbol
         AND s.repo_id = sr.repo_id
         AND s.commit_sha = sr.commit_sha
       JOIN indexes i ON i.id = sr.index_id AND i.status = 'ready'
       JOIN repos r ON r.id = sr.repo_id
       WHERE ${where}
       ORDER BY sr.from_symbol
       LIMIT $${params.length}`,
      params
    );

    return reply.send({
      scip_symbol: sym,
      total,
      truncated: total > limit,
      implementors: rows.rows.map((row) => ({
        from_symbol: row.from_symbol,
        display_name: row.display_name,
        kind: row.kind,
        file_path: row.file_path,
        start_line: row.start_line,
        repo: `${row.repo_org}/${row.repo_name}`,
        commit_sha: row.commit_sha,
      })),
    });
  });
}
