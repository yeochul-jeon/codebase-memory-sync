import type { FastifyInstance } from "fastify";
import { getPool } from "../storage/postgres.js";

export async function symbolsRoutes(app: FastifyInstance): Promise<void> {
  // Look up a symbol by its canonical SCIP symbol string.
  // Returns symbol metadata + top occurrences.
  app.get<{ Querystring: { scip_symbol?: string } }>(
    "/v1/symbols",
    async (request, reply) => {
      const { scip_symbol } = request.query;

      if (!scip_symbol || scip_symbol.trim().length === 0) {
        return reply.status(400).send({
          error: "missing_scip_symbol",
          detail: "scip_symbol query param is required",
        });
      }

      const pool = getPool();

      // Look up the symbol — prefer ready indexes
      const symRes = await pool.query<{
        scip_symbol: string;
        display_name: string | null;
        kind: string | null;
        language: string | null;
        file_path: string;
        start_line: number | null;
        start_col: number | null;
        end_line: number | null;
        end_col: number | null;
        signature: string | null;
        doc: string | null;
        repo_org: string;
        repo_name: string;
        commit_sha: string;
      }>(
        `SELECT s.scip_symbol, s.display_name, s.kind, s.language,
                s.file_path, s.start_line, s.start_col, s.end_line, s.end_col,
                s.signature, s.doc, s.commit_sha,
                r.org AS repo_org, r.name AS repo_name
         FROM symbols s
         JOIN indexes i ON i.id = s.index_id AND i.status = 'ready'
         JOIN repos r ON r.id = s.repo_id
         WHERE s.scip_symbol = $1
         ORDER BY i.created_at DESC
         LIMIT 1`,
        [scip_symbol.trim()]
      );

      if (symRes.rows.length === 0) {
        return reply.status(404).send({
          error: "symbol_not_found",
          detail: `Symbol not found: ${scip_symbol}`,
        });
      }

      const sym = symRes.rows[0]!;

      // Fetch top occurrences (definitions first, then reads)
      const occRes = await pool.query<{
        file_path: string;
        start_line: number | null;
        start_col: number | null;
        end_line: number | null;
        end_col: number | null;
        role: number;
      }>(
        `SELECT o.file_path, o.start_line, o.start_col, o.end_line, o.end_col, o.role
         FROM occurrences o
         JOIN indexes i ON i.id = o.index_id AND i.status = 'ready'
         WHERE o.scip_symbol = $1
         ORDER BY (o.role & 1) DESC, o.file_path, o.start_line
         LIMIT 20`,
        [scip_symbol.trim()]
      );

      return reply.send({
        symbol: {
          scip_symbol: sym.scip_symbol,
          display_name: sym.display_name,
          kind: sym.kind,
          language: sym.language,
          file_path: sym.file_path,
          start_line: sym.start_line,
          start_col: sym.start_col,
          end_line: sym.end_line,
          end_col: sym.end_col,
          signature: sym.signature,
          doc: sym.doc,
        },
        repo: `${sym.repo_org}/${sym.repo_name}`,
        commit_sha: sym.commit_sha,
        occurrences: occRes.rows,
      });
    }
  );
}
