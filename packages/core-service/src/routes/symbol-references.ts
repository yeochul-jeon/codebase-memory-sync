import type { FastifyInstance } from "fastify";
import { getPool } from "../storage/postgres.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export async function symbolReferencesRoutes(
  app: FastifyInstance
): Promise<void> {
  app.get<{
    Querystring: {
      scip_symbol?: string;
      repo?: string;
      include_definitions?: string;
      limit?: string;
    };
  }>("/v1/symbols/references", async (request, reply) => {
    const {
      scip_symbol,
      repo,
      include_definitions,
      limit: limitStr,
    } = request.query;

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

    const includeDefinitions =
      include_definitions === "true" || include_definitions === "1";
    const sym = scip_symbol.trim();
    const pool = getPool();

    const params: unknown[] = [sym];
    const whereClauses: string[] = ["o.scip_symbol = $1"];

    if (!includeDefinitions) {
      whereClauses.push("(o.role & 1) = 0");
    }

    if (org && repoName) {
      params.push(org, repoName);
      whereClauses.push(
        `r.org = $${params.length - 1} AND r.name = $${params.length}`
      );
    }

    const where = whereClauses.join(" AND ");

    const countRes = await pool.query<{ total: string }>(
      `SELECT COUNT(*) AS total
       FROM occurrences o
       JOIN indexes i ON i.id = o.index_id AND i.status = 'ready'
       JOIN repos r ON r.id = o.repo_id
       WHERE ${where}`,
      params
    );
    const total = parseInt(countRes.rows[0]!.total, 10);

    if (total === 0) {
      return reply.status(404).send({
        error: "symbol_not_found",
        detail: `No occurrences found for symbol: ${sym}`,
      });
    }

    params.push(limit);
    const occRes = await pool.query<{
      file_path: string;
      start_line: number | null;
      start_col: number | null;
      end_line: number | null;
      end_col: number | null;
      role: number;
      repo_org: string;
      repo_name: string;
      commit_sha: string;
    }>(
      `SELECT o.file_path, o.start_line, o.start_col, o.end_line, o.end_col, o.role,
              r.org AS repo_org, r.name AS repo_name, o.commit_sha
       FROM occurrences o
       JOIN indexes i ON i.id = o.index_id AND i.status = 'ready'
       JOIN repos r ON r.id = o.repo_id
       WHERE ${where}
       ORDER BY (o.role & 1) DESC, o.file_path, o.start_line
       LIMIT $${params.length}`,
      params
    );

    const first = occRes.rows[0]!;
    return reply.send({
      scip_symbol: sym,
      repo: `${first.repo_org}/${first.repo_name}`,
      commit_sha: first.commit_sha,
      total,
      truncated: total > limit,
      occurrences: occRes.rows.map(
        ({ repo_org: _o, repo_name: _n, commit_sha: _c, ...rest }) => rest
      ),
    });
  });
}
