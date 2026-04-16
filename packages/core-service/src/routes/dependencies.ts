import type { FastifyInstance } from "fastify";
import { getPool } from "../storage/postgres.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export async function dependenciesRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: {
      scip_symbol?: string;
      repo?: string;
      limit?: string;
    };
  }>("/v1/symbols/dependencies", async (request, reply) => {
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
    const whereClauses: string[] = ["sr.from_symbol = $1"];

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
        detail: `No dependencies found for symbol: ${sym}`,
      });
    }

    params.push(limit);
    const rows = await pool.query<{
      to_symbol: string;
      display_name: string | null;
      kind: string | null;
      file_path: string | null;
      start_line: number | null;
      is_reference: boolean;
      is_implementation: boolean;
      is_type_definition: boolean;
      is_definition: boolean;
      repo_org: string;
      repo_name: string;
      commit_sha: string;
    }>(
      `SELECT
         sr.to_symbol,
         sr.is_reference, sr.is_implementation, sr.is_type_definition, sr.is_definition,
         s.display_name, s.kind, s.file_path, s.start_line,
         r.org AS repo_org, r.name AS repo_name, sr.commit_sha
       FROM symbol_relationships sr
       LEFT JOIN symbols s
         ON s.scip_symbol = sr.to_symbol
         AND s.repo_id = sr.repo_id
         AND s.commit_sha = sr.commit_sha
       JOIN indexes i ON i.id = sr.index_id AND i.status = 'ready'
       JOIN repos r ON r.id = sr.repo_id
       WHERE ${where}
       ORDER BY sr.to_symbol
       LIMIT $${params.length}`,
      params
    );

    return reply.send({
      scip_symbol: sym,
      total,
      truncated: total > limit,
      dependencies: rows.rows.map((row) => ({
        to_symbol: row.to_symbol,
        display_name: row.display_name,
        kind: row.kind,
        file_path: row.file_path,
        start_line: row.start_line,
        is_reference: row.is_reference,
        is_implementation: row.is_implementation,
        is_type_definition: row.is_type_definition,
        is_definition: row.is_definition,
        repo: `${row.repo_org}/${row.repo_name}`,
        commit_sha: row.commit_sha,
      })),
    });
  });
}
