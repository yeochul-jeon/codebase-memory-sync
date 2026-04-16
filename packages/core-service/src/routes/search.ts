import type { FastifyInstance } from "fastify";
import { getPool } from "../storage/postgres.js";

export async function searchRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: { q: string; repo?: string; lang?: string; kind?: string; limit?: string };
  }>("/v1/search", async (request, reply) => {
    const { q, repo, lang, kind } = request.query;
    const limit = Math.min(parseInt(request.query.limit ?? "50", 10), 200);

    if (!q || q.trim().length === 0) {
      return reply.status(400).send({ error: "missing_query", detail: "q is required" });
    }

    const params: unknown[] = [];
    const conditions: string[] = [];

    // Full-text prefix search on display_name
    // Note: $N || ':*' builds a valid prefix tsquery from the param string
    params.push(q.trim());
    conditions.push(`to_tsvector('simple', COALESCE(s.display_name, '')) @@ to_tsquery('simple', $${params.length} || ':*')`);

    if (repo) {
      const slashIdx = repo.indexOf("/");
      if (slashIdx !== -1) {
        params.push(repo.slice(0, slashIdx));
        conditions.push(`r.org = $${params.length}`);
        params.push(repo.slice(slashIdx + 1));
        conditions.push(`r.name = $${params.length}`);
      }
    }

    if (lang) {
      params.push(lang);
      conditions.push(`s.language = $${params.length}`);
    }

    if (kind) {
      params.push(kind);
      conditions.push(`s.kind = $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit);

    const sql = `
      SELECT s.scip_symbol, s.display_name, s.kind, s.language,
             s.file_path, s.start_line, s.end_line,
             r.org || '/' || r.name AS repo,
             s.commit_sha
      FROM symbols s
      JOIN repos r ON r.id = s.repo_id
      JOIN indexes i ON i.id = s.index_id AND i.status = 'ready'
      ${where}
      ORDER BY s.display_name
      LIMIT $${params.length}
    `;

    const res = await getPool().query(sql, params);
    return reply.send({ results: res.rows, total: res.rows.length });
  });
}
