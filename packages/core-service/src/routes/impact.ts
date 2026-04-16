import type { FastifyInstance } from "fastify";
import { getPool } from "../storage/postgres.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const DEFAULT_DEPTH = 3;
const MAX_DEPTH = 5;

export async function impactRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: {
      scip_symbol?: string;
      repo?: string;
      depth?: string;
      limit?: string;
    };
  }>("/v1/symbols/impact", async (request, reply) => {
    const { scip_symbol, repo, depth: depthStr, limit: limitStr } = request.query;

    if (!scip_symbol || scip_symbol.trim().length === 0) {
      return reply.status(400).send({
        error: "missing_scip_symbol",
        detail: "scip_symbol query param is required",
      });
    }

    let depth = DEFAULT_DEPTH;
    if (depthStr !== undefined) {
      const parsed = parseInt(depthStr, 10);
      if (isNaN(parsed) || parsed < 1 || parsed > MAX_DEPTH) {
        return reply.status(400).send({
          error: "invalid_depth",
          detail: `depth must be between 1 and ${MAX_DEPTH}`,
        });
      }
      depth = parsed;
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

    // Build optional repo JOIN condition
    const repoParams: unknown[] = [];
    let repoJoin = "";
    let repoWhere = "";
    if (org && repoName) {
      repoParams.push(org, repoName);
      repoJoin = `JOIN repos r_filter ON r_filter.id = sr.repo_id
                  AND r_filter.org = $REPO_ORG AND r_filter.name = $REPO_NAME`;
      repoWhere = `AND r_filter.id = sr.repo_id`;
    }

    // Parameterized positions: $1=sym, $2=depth, $3=limit [, $4=org, $5=name]
    const params: unknown[] = [sym, depth, limit, ...repoParams];
    const orgIdx = repoParams.length > 0 ? params.length - 1 : 0;
    const nameIdx = repoParams.length > 0 ? params.length : 0;

    const repoFilter =
      org && repoName
        ? `AND EXISTS (
             SELECT 1 FROM repos r2
             WHERE r2.id = sr.repo_id
               AND r2.org = $${orgIdx} AND r2.name = $${nameIdx}
           )`
        : "";

    const cte = `
      WITH RECURSIVE impact(symbol, depth, path) AS (
        -- Seed: who directly depends on the target?
        SELECT DISTINCT
          sr.from_symbol,
          1,
          ARRAY[sr.from_symbol]
        FROM symbol_relationships sr
        JOIN indexes i ON i.id = sr.index_id AND i.status = 'ready'
        WHERE sr.to_symbol = $1
          ${repoFilter}

        UNION ALL

        -- Recurse: who depends on the dependents?
        SELECT DISTINCT
          sr.from_symbol,
          imp.depth + 1,
          imp.path || sr.from_symbol
        FROM symbol_relationships sr
        JOIN indexes i ON i.id = sr.index_id AND i.status = 'ready'
        JOIN impact imp ON imp.symbol = sr.to_symbol
        WHERE imp.depth < $2
          AND NOT (sr.from_symbol = ANY(imp.path))
          ${repoFilter}
      )
    `;

    const countRes = await pool.query<{ total: string }>(
      `${cte}
       SELECT COUNT(DISTINCT symbol)::text AS total FROM impact`,
      params.slice(0, repoParams.length > 0 ? 2 + repoParams.length : 2)
    );

    const total = parseInt(countRes.rows[0]!.total, 10);

    if (total === 0) {
      return reply.status(404).send({
        error: "symbol_not_found",
        detail: `No dependents found for symbol: ${sym}`,
      });
    }

    const rows = await pool.query<{
      symbol: string;
      depth: number;
      display_name: string | null;
      kind: string | null;
      file_path: string | null;
      start_line: number | null;
      repo_org: string | null;
      repo_name: string | null;
      commit_sha: string | null;
    }>(
      `${cte}
       SELECT DISTINCT ON (imp.symbol)
         imp.symbol, imp.depth,
         s.display_name, s.kind, s.file_path, s.start_line,
         r.org AS repo_org, r.name AS repo_name, s.commit_sha
       FROM impact imp
       LEFT JOIN symbols s ON s.scip_symbol = imp.symbol
       LEFT JOIN repos r ON r.id = s.repo_id
       ORDER BY imp.symbol, imp.depth
       LIMIT $3`,
      params
    );

    return reply.send({
      scip_symbol: sym,
      depth,
      total,
      truncated: total > limit,
      impacted: rows.rows.map((row) => ({
        symbol: row.symbol,
        display_name: row.display_name,
        kind: row.kind,
        file_path: row.file_path,
        start_line: row.start_line,
        depth: row.depth,
        repo:
          row.repo_org && row.repo_name
            ? `${row.repo_org}/${row.repo_name}`
            : null,
        commit_sha: row.commit_sha,
      })),
    });
  });
}
