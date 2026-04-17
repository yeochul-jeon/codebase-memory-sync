/**
 * SCIP processor worker.
 *
 * Listens on Postgres NOTIFY 'cms_index_ready' (payload = index UUID).
 * For each notification:
 *   1. Load index row to get blob_key, repo_id, commit_sha, branch
 *   2. Download SCIP blob from MinIO
 *   3. Parse SCIP → ParsedIndex
 *   4. Materialize into Postgres (symbols + occurrences) in a single transaction
 *   5. On error → mark index.status = 'failed'
 */

import pg from "pg";
import {
  S3Client,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { config } from "./config.js";
import { parseScip } from "./parser.js";
import { materialize } from "./materialize.js";

// ── Postgres pool ─────────────────────────────────────────────────────────────
const pool = new pg.Pool({
  host: config.POSTGRES_HOST,
  port: config.POSTGRES_PORT,
  database: config.POSTGRES_DB,
  user: config.POSTGRES_USER,
  password: config.POSTGRES_PASSWORD,
  max: 5,
});

// ── MinIO / S3 client ─────────────────────────────────────────────────────────
const s3 = new S3Client({
  endpoint: `http${config.MINIO_USE_SSL ? "s" : ""}://${config.MINIO_ENDPOINT}:${config.MINIO_PORT}`,
  region: "us-east-1",
  credentials: {
    accessKeyId: config.MINIO_ROOT_USER,
    secretAccessKey: config.MINIO_ROOT_PASSWORD,
  },
  forcePathStyle: true,
});

async function downloadBlob(key: string): Promise<Buffer> {
  const resp = await s3.send(
    new GetObjectCommand({ Bucket: config.MINIO_BUCKET, Key: key })
  );
  if (!resp.Body) throw new Error(`Empty body for key: ${key}`);
  const stream = resp.Body as Readable;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

async function processIndex(indexId: string): Promise<void> {
  // Load index row
  const rowRes = await pool.query<{
    id: string;
    repo_id: string;
    commit_sha: string;
    branch: string;
    blob_key: string;
    status: string;
  }>(
    "SELECT id, repo_id, commit_sha, branch, blob_key, status FROM indexes WHERE id = $1",
    [indexId]
  );

  if (rowRes.rows.length === 0) {
    console.warn(`[worker] Index ${indexId} not found — skipping`);
    return;
  }

  const row = rowRes.rows[0]!;
  if (row.status === "ready") {
    console.info(`[worker] Index ${indexId} already ready — skipping`);
    return;
  }

  console.info(`[worker] Processing index ${indexId} (${row.blob_key})`);

  try {
    const blob = await downloadBlob(row.blob_key);
    const parsed = await parseScip(blob);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await materialize(client, {
        indexId: row.id,
        repoId: row.repo_id,
        commitSha: row.commit_sha,
        branch: row.branch,
        parsed,
      });
      await client.query("COMMIT");
      console.info(
        `[worker] Index ${indexId} materialized: ${parsed.symbols.length} symbols, ${parsed.occurrences.length} occurrences`
      );
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(`[worker] Failed to process index ${indexId}:`, err);
    await pool.query(
      "UPDATE indexes SET status = 'failed', error_msg = $1, updated_at = NOW() WHERE id = $2",
      [String(err), indexId]
    );
  }
}

// ── LISTEN / NOTIFY ───────────────────────────────────────────────────────────
async function startListening(): Promise<void> {
  // Use a dedicated client (not pool) for LISTEN — connection must stay open
  const listenClient = new pg.Client({
    host: config.POSTGRES_HOST,
    port: config.POSTGRES_PORT,
    database: config.POSTGRES_DB,
    user: config.POSTGRES_USER,
    password: config.POSTGRES_PASSWORD,
  });

  await listenClient.connect();

  listenClient.on("notification", (msg) => {
    const indexId = msg.payload;
    if (!indexId) return;
    // Fire-and-forget per notification; errors are caught inside processIndex
    void processIndex(indexId);
  });

  listenClient.on("error", (err) => {
    console.error("[worker] LISTEN client error:", err);
    process.exit(1);
  });

  await listenClient.query("LISTEN cms_index_ready");
  console.info("[worker] Listening on channel cms_index_ready");

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    console.info("[worker] Shutting down");
    await listenClient.end();
    await pool.end();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

await startListening();
