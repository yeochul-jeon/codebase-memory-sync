import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { getPool } from "../storage/postgres.js";
import { getSourceZipEntry } from "../storage/minio.js";
import { parseRepo, resolveCommit } from "../services/commit-resolver.js";

interface SymbolRow {
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
      const branch = q["branch"];
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

      const parsed = parseRepo(repo);
      if (!parsed) {
        return reply.status(400).send({ error: "invalid_repo", detail: "repo must be 'org/name'" });
      }
      const { org, name } = parsed;

      const pool = getPool();
      const r = await resolveCommit(pool, { org, name, commit, ...(branch !== undefined ? { branch } : {}) });
      if (!r.ok) {
        return reply.status(r.error.status).send({ error: r.error.code, detail: r.error.detail });
      }
      const { commitSha, sourceBlobKey } = r.value;

      if (!sourceBlobKey) {
        return reply.status(404).send({
          error: "source_not_available",
          detail: "This index was uploaded by a client uploader. Source is only retained for CI uploads.",
          hint: `Trigger a CI build for commit ${commitSha} to make source available.`,
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
        commit_sha: commitSha,
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
      const branch = q["branch"];

      if (!scipSymbol) return reply.status(400).send({ error: "missing_scip_symbol" });
      if (!repo) return reply.status(400).send({ error: "missing_repo" });

      const parsed = parseRepo(repo);
      if (!parsed) {
        return reply.status(400).send({ error: "invalid_repo" });
      }
      const { org, name } = parsed;

      const pool = getPool();
      const r = await resolveCommit(pool, { org, name, commit, ...(branch !== undefined ? { branch } : {}) });
      if (!r.ok) {
        return reply.status(r.error.status).send({ error: r.error.code, detail: r.error.detail });
      }
      const { indexId, commitSha, sourceBlobKey } = r.value;

      const symRes = await pool.query<SymbolRow>(
        `SELECT file_path, body_start_line, body_start_col, body_end_line, body_end_col, start_line
         FROM symbols
         WHERE index_id = $1 AND scip_symbol = $2
         LIMIT 1`,
        [indexId, scipSymbol]
      );
      if (symRes.rows.length === 0) {
        return reply.status(404).send({ error: "symbol_not_found" });
      }
      const row = symRes.rows[0]!;

      if (!sourceBlobKey) {
        return reply.status(404).send({
          error: "source_not_available",
          detail: "Source is only available for CI-indexed commits.",
          hint: `Trigger a CI build for commit ${commitSha}.`,
        });
      }

      const fileBuffer = await getSourceZipEntry(sourceBlobKey, row.file_path);
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
        commit_sha: commitSha,
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
