/**
 * Integration tests for POST /v1/scip/upload — Phase 2c source upload.
 *
 * Tests the CI source.zip requirement and client rejection behaviors.
 * Requires Postgres; mocks MinIO.
 * Skip gracefully if Postgres unavailable.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import pg from "pg";
import multipart from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import { putScipBlob, putSourceBlob } from "../../src/storage/minio.js";

// Mock MinIO before any imports that might use it
vi.mock("../../src/storage/minio.js", () => ({
  putScipBlob: vi.fn().mockResolvedValue(undefined),
  putSourceBlob: vi.fn().mockResolvedValue(undefined),
  getScipBlob: vi.fn(),
  getSourceBlob: vi.fn(),
  extractZipEntry: vi.fn(),
  getSourceZipEntry: vi.fn(),
  ensureBucket: vi.fn().mockResolvedValue(undefined),
  checkMinioHealth: vi.fn().mockResolvedValue(true),
}));

import { buildApp } from "../helpers/build-app.js";
import { uploadRoutes } from "../../src/routes/upload.js";
import { runMigrations } from "../../src/storage/postgres.js";

const DB_CONFIG = {
  host: process.env["POSTGRES_HOST"] ?? "localhost",
  port: Number(process.env["POSTGRES_PORT"] ?? 5432),
  database: process.env["POSTGRES_DB"] ?? "cms",
  user: process.env["POSTGRES_USER"] ?? "cms",
  password: process.env["POSTGRES_PASSWORD"] ?? "",
};

const CI_TOKEN = process.env["CMS_CI_TOKEN"] ?? "ci-secret-token";
const CLIENT_TOKEN = process.env["CMS_CLIENT_TOKEN"] ?? "client-secret-token";

const TEST_ORG = "test-upload-phase2c";
const TEST_REPO = "srctest";
const TEST_COMMIT = "1122334455667788990011223344556677889900";
const TEST_TOOL = "scip-java";

let pool: pg.Pool;
let app: FastifyInstance;
let available = false;

const MINIMAL_SCIP = Buffer.from([0x0a, 0x00]); // tiny valid-ish SCIP

function buildMultipart(
  fields: Record<string, string>,
  files: Array<{ name: string; filename: string; content: Buffer; contentType?: string }>
): { body: Buffer; contentType: string } {
  const boundary = "boundary-cms-test-" + Date.now();
  const parts: Buffer[] = [];
  const CRLF = "\r\n";

  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="${name}"${CRLF}` +
        CRLF +
        `${value}${CRLF}`
      )
    );
  }

  for (const file of files) {
    const ct = file.contentType ?? "application/octet-stream";
    parts.push(
      Buffer.concat([
        Buffer.from(
          `--${boundary}${CRLF}` +
          `Content-Disposition: form-data; name="${file.name}"; filename="${file.filename}"${CRLF}` +
          `Content-Type: ${ct}${CRLF}` +
          CRLF
        ),
        file.content,
        Buffer.from(CRLF),
      ])
    );
  }

  parts.push(Buffer.from(`--${boundary}--${CRLF}`));

  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

beforeAll(async () => {
  pool = new pg.Pool({ ...DB_CONFIG, max: 2, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    available = true;
  } catch {
    available = false;
    return;
  }

  // Apply full schema.sql (idempotent) — covers Phase 2c columns and Phase A state machine
  await runMigrations();

  // multipart must be registered at the same (or parent) scope as the routes
  // to escape Fastify encapsulation. Register both in one plugin.
  app = await buildApp(async (a) => {
    await a.register(multipart, { limits: { fileSize: 200 * 1024 * 1024, files: 2 } });
    await uploadRoutes(a);
  });
});

afterAll(async () => {
  if (pool) {
    try {
      await pool.query("DELETE FROM repos WHERE org = $1 AND name = $2", [TEST_ORG, TEST_REPO]);
    } catch {}
    await pool.end();
  }
  if (app) await app.close();
});

describe("POST /v1/scip/upload — Phase 2c source upload", () => {
  it("CI upload with source.zip returns 201 and stores source_blob_key", async () => {
    if (!available) {
      console.warn("Skipping — Postgres not available");
      return;
    }

    const sourceZip = Buffer.from("PK\x03\x04"); // minimal zip magic bytes
    const { body, contentType } = buildMultipart(
      { repo: `${TEST_ORG}/${TEST_REPO}`, commit: TEST_COMMIT, tool: TEST_TOOL },
      [
        { name: "scip", filename: "index.scip", content: MINIMAL_SCIP },
        { name: "source", filename: "source.zip", content: sourceZip, contentType: "application/zip" },
      ]
    );

    const res = await app.inject({
      method: "POST",
      url: "/v1/scip/upload",
      headers: {
        "content-type": contentType,
        "authorization": `Bearer ${CI_TOKEN}`,
        "x-cms-uploader": "ci",
      },
      payload: body,
    });

    expect(res.statusCode).toBe(201);
    const json = JSON.parse(res.body) as { index_id: string; status: string };
    expect(json.status).toBe("pending");

    // source_blob_key should be set in DB
    const row = await pool.query<{ source_blob_key: string | null }>(
      `SELECT i.source_blob_key
       FROM indexes i
       JOIN repos r ON r.id = i.repo_id
       WHERE r.org = $1 AND r.name = $2 AND i.commit_sha = $3`,
      [TEST_ORG, TEST_REPO, TEST_COMMIT]
    );
    expect(row.rows[0]?.source_blob_key).toBe(
      `${TEST_ORG}/${TEST_REPO}/${TEST_COMMIT}/source.zip`
    );
  });

  it("CI upload missing source returns 400 missing_source", async () => {
    if (!available) return;

    const commit = TEST_COMMIT.replace(/0/g, "1"); // distinct commit
    const { body, contentType } = buildMultipart(
      { repo: `${TEST_ORG}/${TEST_REPO}`, commit, tool: TEST_TOOL },
      [{ name: "scip", filename: "index.scip", content: MINIMAL_SCIP }]
    );

    const res = await app.inject({
      method: "POST",
      url: "/v1/scip/upload",
      headers: {
        "content-type": contentType,
        "authorization": `Bearer ${CI_TOKEN}`,
        "x-cms-uploader": "ci",
      },
      payload: body,
    });

    expect(res.statusCode).toBe(400);
    const json = JSON.parse(res.body) as { error: string };
    expect(json.error).toBe("missing_source");
  });

  it("client upload with source part returns 400 source_not_allowed_for_client", async () => {
    if (!available) return;

    const commit = "aabbccddeeff112233445566778899001122334455";
    const sourceZip = Buffer.from("PK\x03\x04");
    const { body, contentType } = buildMultipart(
      { repo: `${TEST_ORG}/${TEST_REPO}`, commit, tool: TEST_TOOL },
      [
        { name: "scip", filename: "index.scip", content: MINIMAL_SCIP },
        { name: "source", filename: "source.zip", content: sourceZip },
      ]
    );

    const res = await app.inject({
      method: "POST",
      url: "/v1/scip/upload",
      headers: {
        "content-type": contentType,
        "authorization": `Bearer ${CLIENT_TOKEN}`,
        "x-cms-uploader": "client",
      },
      payload: body,
    });

    expect(res.statusCode).toBe(400);
    const json = JSON.parse(res.body) as { error: string };
    expect(json.error).toBe("source_not_allowed_for_client");
  });
});

// ── Two-Phase Replace (upload atomicity) ─────────────────────────────────────
// Distinct commit prefixes avoid UNIQUE conflicts with Phase 2c tests above.
const TPR_COMMIT_BASE = "bbbb";

describe("POST /v1/scip/upload — Two-Phase Replace atomicity", () => {
  it("blob PUT failure on fresh upload sets index status to failed", async () => {
    if (!available) { console.warn("Skipping — Postgres not available"); return; }

    vi.mocked(putScipBlob).mockRejectedValueOnce(new Error("MinIO down"));

    const commit = `${TPR_COMMIT_BASE}${"0".repeat(36)}`;
    const { body, contentType } = buildMultipart(
      { repo: `${TEST_ORG}/${TEST_REPO}`, commit, tool: TEST_TOOL },
      [
        { name: "scip", filename: "index.scip", content: MINIMAL_SCIP },
        { name: "source", filename: "source.zip", content: Buffer.from("PK\x03\x04"), contentType: "application/zip" },
      ]
    );

    const res = await app.inject({
      method: "POST",
      url: "/v1/scip/upload",
      headers: {
        "content-type": contentType,
        "authorization": `Bearer ${CI_TOKEN}`,
        "x-cms-uploader": "ci",
      },
      payload: body,
    });

    expect(res.statusCode).toBe(500);

    const row = await pool.query<{ status: string }>(
      `SELECT i.status FROM indexes i
       JOIN repos r ON r.id = i.repo_id
       WHERE r.org = $1 AND r.name = $2 AND i.commit_sha = $3`,
      [TEST_ORG, TEST_REPO, commit]
    );
    expect(row.rows[0]?.status).toBe("failed");
  });

  it("blob PUT failure on CI-replaces-client leaves old client index intact", async () => {
    if (!available) { console.warn("Skipping — Postgres not available"); return; }

    const commit = `${TPR_COMMIT_BASE}${"0".repeat(35)}1`;

    // Step 1: successful client upload
    const { body: b1, contentType: ct1 } = buildMultipart(
      { repo: `${TEST_ORG}/${TEST_REPO}`, commit, tool: TEST_TOOL },
      [{ name: "scip", filename: "index.scip", content: MINIMAL_SCIP }]
    );
    const r1 = await app.inject({
      method: "POST", url: "/v1/scip/upload",
      headers: { "content-type": ct1, "authorization": `Bearer ${CLIENT_TOKEN}`, "x-cms-uploader": "client" },
      payload: b1,
    });
    expect(r1.statusCode).toBe(201);
    const { index_id: clientIndexId } = JSON.parse(r1.body) as { index_id: string };

    // Step 2: CI upload with blob failure
    vi.mocked(putScipBlob).mockRejectedValueOnce(new Error("MinIO down"));
    const { body: b2, contentType: ct2 } = buildMultipart(
      { repo: `${TEST_ORG}/${TEST_REPO}`, commit, tool: TEST_TOOL },
      [
        { name: "scip", filename: "index.scip", content: MINIMAL_SCIP },
        { name: "source", filename: "source.zip", content: Buffer.from("PK\x03\x04"), contentType: "application/zip" },
      ]
    );
    await app.inject({
      method: "POST", url: "/v1/scip/upload",
      headers: { "content-type": ct2, "authorization": `Bearer ${CI_TOKEN}`, "x-cms-uploader": "ci" },
      payload: b2,
    });

    // Old client index must still be present
    const row = await pool.query<{ id: string }>(
      "SELECT id FROM indexes WHERE id = $1",
      [clientIndexId]
    );
    expect(row.rows).toHaveLength(1);
  });

  it("successful CI over client deletes old index and transitions to pending", async () => {
    if (!available) { console.warn("Skipping — Postgres not available"); return; }

    const commit = `${TPR_COMMIT_BASE}${"0".repeat(35)}2`;

    // Step 1: client upload
    const { body: b1, contentType: ct1 } = buildMultipart(
      { repo: `${TEST_ORG}/${TEST_REPO}`, commit, tool: TEST_TOOL },
      [{ name: "scip", filename: "index.scip", content: MINIMAL_SCIP }]
    );
    const r1 = await app.inject({
      method: "POST", url: "/v1/scip/upload",
      headers: { "content-type": ct1, "authorization": `Bearer ${CLIENT_TOKEN}`, "x-cms-uploader": "client" },
      payload: b1,
    });
    expect(r1.statusCode).toBe(201);
    const { index_id: clientIndexId } = JSON.parse(r1.body) as { index_id: string };

    // Step 2: CI upload (blobs succeed via mock default)
    const { body: b2, contentType: ct2 } = buildMultipart(
      { repo: `${TEST_ORG}/${TEST_REPO}`, commit, tool: TEST_TOOL },
      [
        { name: "scip", filename: "index.scip", content: MINIMAL_SCIP },
        { name: "source", filename: "source.zip", content: Buffer.from("PK\x03\x04"), contentType: "application/zip" },
      ]
    );
    const r2 = await app.inject({
      method: "POST", url: "/v1/scip/upload",
      headers: { "content-type": ct2, "authorization": `Bearer ${CI_TOKEN}`, "x-cms-uploader": "ci" },
      payload: b2,
    });
    expect(r2.statusCode).toBe(201);
    expect((JSON.parse(r2.body) as { status: string }).status).toBe("pending");

    // Old client index must be gone
    const oldRow = await pool.query<{ id: string }>("SELECT id FROM indexes WHERE id = $1", [clientIndexId]);
    expect(oldRow.rows).toHaveLength(0);

    // New CI index must have status='pending'
    const newRow = await pool.query<{ status: string }>(
      `SELECT i.status FROM indexes i
       JOIN repos r ON r.id = i.repo_id
       WHERE r.org = $1 AND r.name = $2 AND i.commit_sha = $3`,
      [TEST_ORG, TEST_REPO, commit]
    );
    expect(newRow.rows[0]?.status).toBe("pending");
  });
});
