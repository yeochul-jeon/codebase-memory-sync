import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { getPool } from "../storage/postgres.js";
import { putScipBlob, putSourceBlob } from "../storage/minio.js";
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
      let sourceBuffer: Buffer | null = null;

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
              part.file.resume();
              return reply.status(413).send({
                error: "payload_too_large",
                detail: `SCIP file exceeds ${config.MAX_SCIP_SIZE_MB}MB limit`,
              });
            }
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
          }
          scipBuffer = Buffer.concat(chunks);
        } else if (part.type === "file" && part.fieldname === "source") {
          const chunks: Buffer[] = [];
          let totalSize = 0;
          const maxBytes = config.MAX_SOURCE_SIZE_MB * 1024 * 1024;
          for await (const chunk of part.file) {
            totalSize += chunk.length;
            if (totalSize > maxBytes) {
              part.file.resume();
              return reply.status(413).send({
                error: "source_too_large",
                detail: `Source archive exceeds ${config.MAX_SOURCE_SIZE_MB}MB limit`,
              });
            }
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
          }
          sourceBuffer = Buffer.concat(chunks);
        }
      }

      // Validate required fields
      const { repo, commit, branch, tool } = fields;
      if (!repo || !commit || !tool || !branch || branch.trim() === "") {
        return reply.status(400).send({
          error: "missing_fields",
          detail: "repo, commit, branch, tool are required (branch must be non-empty)",
        });
      }
      if (!scipBuffer || scipBuffer.length === 0) {
        return reply.status(400).send({ error: "missing_scip", detail: "multipart field 'scip' with binary content is required" });
      }

      // source part validation (CI required, client forbidden)
      const uploaderForSourceCheck = (request as UploaderRequest).uploader;
      if (uploaderForSourceCheck === "ci" && (!sourceBuffer || sourceBuffer.length === 0)) {
        return reply.status(400).send({
          error: "missing_source",
          detail: "CI uploads must include a 'source' multipart field (source.zip archive)",
        });
      }
      if (uploaderForSourceCheck === "client" && sourceBuffer) {
        return reply.status(400).send({
          error: "source_not_allowed_for_client",
          detail: "Client uploads must not include a 'source' field. Source is managed by CI uploads only.",
        });
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

        // Insert new index row with status='uploading' (Phase 1 — safe to COMMIT)
        const blobKey = `${org}/${name}/${commit}/${tool}.scip`;
        const sourceBlobKey = sourceBuffer ? `${org}/${name}/${commit}/source.zip` : null;
        const sourceSha256 = sourceBuffer ? createHash("sha256").update(sourceBuffer).digest("hex") : null;
        const sourceBytes = sourceBuffer ? sourceBuffer.length : null;

        const indexRes = await client.query<{ id: string }>(
          `INSERT INTO indexes
             (repo_id, commit_sha, branch, uploader, tool, tool_version,
              blob_key, blob_sha256,
              source_blob_key, source_sha256, source_bytes,
              status, status_transition_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'uploading', NOW())
           RETURNING id`,
          [
            repoId,
            commit,
            branch,
            uploader,
            tool,
            fields["tool_version"] ?? null,
            blobKey,
            blobSha256,
            sourceBlobKey,
            sourceSha256,
            sourceBytes,
          ]
        );
        const indexId = indexRes.rows[0]!.id;
        const replacesId = decision.action === "insert" ? decision.replaces : undefined;

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

        // Phase 1 COMMIT: index row exists as 'uploading'; old row (if any) is 'reclaiming'
        await client.query("COMMIT");

        // Phase 2: blob PUT — outside the transaction; may fail
        try {
          await putScipBlob(blobKey, scipBuffer);
          if (sourceBuffer && sourceBlobKey) {
            await putSourceBlob(sourceBlobKey, sourceBuffer);
          }
        } catch (blobErr) {
          // Blob failed: mark new index as 'failed'; restore old index if present
          request.log.error(blobErr, "Blob PUT failed — marking index as failed");
          await pool.query(
            "UPDATE indexes SET status = 'failed', status_transition_at = NOW() WHERE id = $1",
            [indexId]
          );
          if (replacesId) {
            await pool.query(
              "UPDATE indexes SET status = 'pending', status_transition_at = NOW() WHERE id = $1",
              [replacesId]
            );
          }
          return reply.status(500).send({ error: "blob_upload_failed" });
        }

        // Phase 2 success: activate new index, remove replaced index
        const phase2Client = await pool.connect();
        try {
          await phase2Client.query("BEGIN");
          if (replacesId) {
            await phase2Client.query("DELETE FROM indexes WHERE id = $1", [replacesId]);
          }
          await phase2Client.query(
            "UPDATE indexes SET status = 'pending', status_transition_at = NOW() WHERE id = $1",
            [indexId]
          );
          await phase2Client.query("COMMIT");
        } catch (activateErr) {
          await phase2Client.query("ROLLBACK");
          request.log.error(activateErr, "Phase 2 activation failed");
          await pool.query(
            "UPDATE indexes SET status = 'failed', status_transition_at = NOW() WHERE id = $1",
            [indexId]
          );
          return reply.status(500).send({ error: "internal_error" });
        } finally {
          phase2Client.release();
        }

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
