import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { getPool } from "../storage/postgres.js";
import { getSourceZipEntry } from "../storage/minio.js";

interface SymbolRow {
  source_blob_key: string | null;
  file_path: string;
  body_start_line: number | null;
  body_start_col: number | null;
  body_end_line: number | null;
  body_end_col: number | null;
  start_line: number;
}

const MAX_LINE_RANGE = 2000;

function extractLines(content: string, startLine: number, endLine: number): string {
  const lines = content.split("\n");
  // Lines are 1-indexed; slice is exclusive on end
  return lines.slice(startLine - 1, endLine).join("\n");
}

export async function sourcesRoutes(app: FastifyInstance): Promise<void> {
  // GET /v1/sources/file — return source lines for a file path + range
  app.get(
    "/v1/sources/file",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const q = request.query as Record<string, string>;
      const repo = q["repo"];
      const commit = q["commit"];
      const filePath = q["file_path"];
      const startLine = q["start_line"] ? parseInt(q["start_line"]!, 10) : undefined;
      const endLine = q["end_line"] ? parseInt(q["end_line"]!, 10) : undefined;

      if (!repo) return reply.status(400).send({ error: "missing_repo" });
      if (!filePath) return reply.status(400).send({ error: "missing_file_path" });
      if (startLine === undefined || isNaN(startLine) || startLine < 1) {
        return reply.status(400).send({ error: "invalid_start_line" });
      }
      if (endLine === undefined || isNaN(endLine) || endLine < startLine) {
        return reply.status(400).send({ error: "invalid_end_line" });
      }
      if (endLine - startLine + 1 > MAX_LINE_RANGE) {
        return reply.status(400).send({
          error: "range_too_large",
          detail: `Line range must not exceed ${MAX_LINE_RANGE} lines`,
        });
      }

      const slashIdx = repo.indexOf("/");
      if (slashIdx === -1) {
        return reply.status(400).send({ error: "invalid_repo", detail: "repo must be 'org/name'" });
      }
      const org = repo.slice(0, slashIdx);
      const name = repo.slice(slashIdx + 1);

      const pool = getPool();

      // Resolve repo + index
      let sourceBlobKey: string | null = null;
      let resolvedCommit: string;

      if (commit) {
        const row = await pool.query<{ source_blob_key: string | null; commit_sha: string }>(
          `SELECT i.source_blob_key, i.commit_sha
           FROM indexes i
           JOIN repos r ON r.id = i.repo_id
           WHERE r.org = $1 AND r.name = $2 AND i.commit_sha = $3 AND i.status = 'ready'
           LIMIT 1`,
          [org, name, commit]
        );
        if (row.rows.length === 0) {
          return reply.status(404).send({ error: "index_not_found" });
        }
        sourceBlobKey = row.rows[0]!.source_blob_key;
        resolvedCommit = row.rows[0]!.commit_sha;
      } else {
        const row = await pool.query<{ source_blob_key: string | null; commit_sha: string }>(
          `SELECT i.source_blob_key, i.commit_sha
           FROM repo_head rh
           JOIN repos r ON r.id = rh.repo_id
           JOIN indexes i ON i.id = rh.index_id
           WHERE r.org = $1 AND r.name = $2 AND i.status = 'ready'
           LIMIT 1`,
          [org, name]
        );
        if (row.rows.length === 0) {
          return reply.status(404).send({ error: "index_not_found" });
        }
        sourceBlobKey = row.rows[0]!.source_blob_key;
        resolvedCommit = row.rows[0]!.commit_sha;
      }

      if (!sourceBlobKey) {
        return reply.status(404).send({
          error: "source_not_available",
          detail: "This index was uploaded by a client uploader. Source is only retained for CI uploads.",
          hint: `Trigger a CI build for commit ${resolvedCommit!} to make source available.`,
        });
      }

      const fileBuffer = await getSourceZipEntry(sourceBlobKey, filePath);
      if (!fileBuffer) {
        return reply.status(404).send({ error: "file_not_found_in_source", detail: `${filePath} not found in source archive` });
      }

      const fullContent = fileBuffer.toString("utf8");
      const content = extractLines(fullContent, startLine, endLine);

      return reply.send({
        repo,
        commit_sha: resolvedCommit!,
        file_path: filePath,
        start_line: startLine,
        end_line: endLine,
        content,
      });
    }
  );

  // GET /v1/sources/symbol — return source body for a symbol
  app.get(
    "/v1/sources/symbol",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const q = request.query as Record<string, string>;
      const scipSymbol = q["scip_symbol"];
      const repo = q["repo"];
      const commit = q["commit"];

      if (!scipSymbol) return reply.status(400).send({ error: "missing_scip_symbol" });
      if (!repo) return reply.status(400).send({ error: "missing_repo" });

      const slashIdx = repo.indexOf("/");
      if (slashIdx === -1) {
        return reply.status(400).send({ error: "invalid_repo" });
      }
      const org = repo.slice(0, slashIdx);
      const name = repo.slice(slashIdx + 1);

      const pool = getPool();

      let row: SymbolRow | undefined;
      let resolvedCommit: string;

      if (commit) {
        const res = await pool.query<SymbolRow & { commit_sha: string }>(
          `SELECT i.source_blob_key, s.file_path,
                  s.body_start_line, s.body_start_col, s.body_end_line, s.body_end_col,
                  s.start_line, i.commit_sha
           FROM symbols s
           JOIN indexes i ON i.id = s.index_id AND i.status = 'ready'
           JOIN repos r ON r.id = i.repo_id
           WHERE r.org = $1 AND r.name = $2 AND s.scip_symbol = $3 AND i.commit_sha = $4
           LIMIT 1`,
          [org, name, scipSymbol, commit]
        );
        if (res.rows.length === 0) {
          return reply.status(404).send({ error: "symbol_not_found" });
        }
        row = res.rows[0]!;
        resolvedCommit = res.rows[0]!.commit_sha;
      } else {
        const res = await pool.query<SymbolRow & { commit_sha: string }>(
          `SELECT i.source_blob_key, s.file_path,
                  s.body_start_line, s.body_start_col, s.body_end_line, s.body_end_col,
                  s.start_line, i.commit_sha
           FROM symbols s
           JOIN indexes i ON i.id = s.index_id AND i.status = 'ready'
           JOIN repos r ON r.id = i.repo_id
           WHERE r.org = $1 AND r.name = $2 AND s.scip_symbol = $3
           ORDER BY i.created_at DESC
           LIMIT 1`,
          [org, name, scipSymbol]
        );
        if (res.rows.length === 0) {
          return reply.status(404).send({ error: "symbol_not_found" });
        }
        row = res.rows[0]!;
        resolvedCommit = res.rows[0]!.commit_sha;
      }

      if (!row.source_blob_key) {
        return reply.status(404).send({
          error: "source_not_available",
          detail: "Source is only available for CI-indexed commits.",
          hint: `Trigger a CI build for commit ${resolvedCommit!}.`,
        });
      }

      const fileBuffer = await getSourceZipEntry(row.source_blob_key, row.file_path);
      if (!fileBuffer) {
        return reply.status(404).send({ error: "file_not_found_in_source" });
      }

      const fullContent = fileBuffer.toString("utf8");

      // Determine body span
      const hasBodySpan = row.body_start_line !== null && row.body_end_line !== null;
      let bodyStartLine: number;
      let bodyEndLine: number;
      if (hasBodySpan) {
        bodyStartLine = row.body_start_line!;
        bodyEndLine = row.body_end_line!;
      } else {
        const totalLines = fullContent.split("\n").length;
        bodyStartLine = Math.max(1, row.start_line - 10);
        bodyEndLine = Math.min(totalLines, row.start_line + 10);
      }
      const bodySource = hasBodySpan ? "enclosing_range" : "identifier_fallback";

      const content = extractLines(fullContent, bodyStartLine, bodyEndLine);

      return reply.send({
        repo,
        commit_sha: resolvedCommit!,
        scip_symbol: scipSymbol,
        file_path: row.file_path,
        start_line: bodyStartLine,
        end_line: bodyEndLine,
        content,
        body_source: bodySource,
      });
    }
  );
}
