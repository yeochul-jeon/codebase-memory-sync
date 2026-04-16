import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { getPool } from "../storage/postgres.js";
import { putScipBlob } from "../storage/minio.js";
import { verifyBearer } from "../auth/bearer.js";
import { resolveConflict } from "../services/conflict.js";
import { config } from "../config.js";

type UploaderRequest = FastifyRequest & { uploader: "ci" | "client" };

export async function uploadRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/v1/scip/upload",
    { preHandler: verifyBearer },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const req = request as UploaderRequest;

      // Parse multipart
      const parts = req.parts();

      const fields: Record<string, string> = {};
      let scipBuffer: Buffer | null = null;

      for await (const part of parts) {
        if (part.type === "field") {
          fields[part.fieldname] = part.value as string;
        } else if (part.type === "file" && part.fieldname === "scip") {
          const chunks: Buffer[] = [];
          let totalSize = 0;
          const maxBytes = config.MAX_SCIP_SIZE_MB * 1024 * 1024;
          for await (const chunk of part.file) {
            totalSize += chunk.length;
            if (totalSize > maxBytes) {
              // Drain stream to avoid socket hang
              part.file.resume();
              return reply.status(413).send({
                error: "payload_too_large",
                detail: `SCIP file exceeds ${config.MAX_SCIP_SIZE_MB}MB limit`,
              });
            }
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
          }
          scipBuffer = Buffer.concat(chunks);
        }
      }

      // Validate required fields
      const { repo, commit, branch, tool } = fields;
      if (!repo || !commit || !tool) {
        return reply.status(400).send({ error: "missing_fields", detail: "repo, commit, tool are required" });
      }
      if (!scipBuffer || scipBuffer.length === 0) {
        return reply.status(400).send({ error: "missing_scip", detail: "multipart field 'scip' with binary content is required" });
      }

      // Parse org/name
      const slashIdx = repo.indexOf("/");
      if (slashIdx === -1) {
        return reply.status(400).send({ error: "invalid_repo", detail: "repo must be 'org/name'" });
      }
      const org = repo.slice(0, slashIdx);
      const name = repo.slice(slashIdx + 1);

      const uploader = req.uploader;
      const idempotencyKey =
        (request.headers["x-cms-idempotency-key"] as string | undefined) ??
        createHash("sha256").update(`${repo}:${commit}:${tool}:${uploader}`).digest("hex");

      const blobSha256 = createHash("sha256").update(scipBuffer).digest("hex");

      const pool = getPool();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Upsert repo
        const repoRes = await client.query<{ id: string }>(
          `INSERT INTO repos (org, name) VALUES ($1, $2)
           ON CONFLICT (org, name) DO UPDATE SET updated_at = NOW()
           RETURNING id`,
          [org, name]
        );
        const repoId = repoRes.rows[0]!.id;

        // Conflict resolution
        const decision = await resolveConflict(client, {
          repoId,
          commitSha: commit,
          tool,
          uploader,
          idempotencyKey,
        });

        if (decision.action === "idempotent") {
          await client.query("ROLLBACK");
          return reply.status(200).send({ cached: true, index_id: decision.indexId, status: "pending" });
        }

        if (decision.action === "ci_wins") {
          await client.query("ROLLBACK");
          return reply.status(409).send({
            error: "ci_wins",
            detail: "A CI-produced index already exists for this commit. Client uploads are not allowed to overwrite it.",
          });
        }

        // Insert new index row (status=pending)
        const blobKey = `${org}/${name}/${commit}/${tool}.scip`;
        const indexRes = await client.query<{ id: string }>(
          `INSERT INTO indexes
             (repo_id, commit_sha, branch, uploader, tool, tool_version, blob_key, blob_sha256, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
           RETURNING id`,
          [
            repoId,
            commit,
            branch ?? null,
            uploader,
            tool,
            fields["tool_version"] ?? null,
            blobKey,
            blobSha256,
          ]
        );
        const indexId = indexRes.rows[0]!.id;

        // Record idempotency key
        await client.query(
          "INSERT INTO upload_receipts (idempotency_key, index_id) VALUES ($1, $2)",
          [idempotencyKey, indexId]
        );

        // Audit
        await client.query(
          "INSERT INTO audit_log (actor, action, repo_id, index_id, detail) VALUES ($1, $2, $3, $4, $5)",
          [uploader, "upload", repoId, indexId, JSON.stringify({ commit, tool, blobKey })]
        );

        await client.query("COMMIT");

        // Upload blob to MinIO (outside transaction — idempotent)
        await putScipBlob(blobKey, scipBuffer);

        // Notify worker
        await pool.query("SELECT pg_notify('cms_index_ready', $1)", [indexId]);

        return reply.status(201).send({ index_id: indexId, status: "pending" });
      } catch (err) {
        await client.query("ROLLBACK");
        request.log.error(err, "Upload failed");
        return reply.status(500).send({ error: "internal_error" });
      } finally {
        client.release();
      }
    }
  );
}
