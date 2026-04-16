/**
 * Integration test for materialize.ts
 * Requires a running Postgres with the CMS schema applied.
 *
 * Set env vars (or use .env via dotenv) before running:
 *   POSTGRES_HOST, POSTGRES_PORT, POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD
 *
 * Skip gracefully if Postgres is unavailable.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildHelloScip } from "./fixtures/build-hello-scip.js";
import { parseScip } from "../src/parser.js";
import { materialize } from "../src/materialize.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DB_CONFIG = {
  host: process.env["POSTGRES_HOST"] ?? "localhost",
  port: Number(process.env["POSTGRES_PORT"] ?? 5432),
  database: process.env["POSTGRES_DB"] ?? "cms",
  user: process.env["POSTGRES_USER"] ?? "cms",
  password: process.env["POSTGRES_PASSWORD"] ?? "",
};

let pool: pg.Pool;
let available = false;

// Test-scope IDs
let repoId: string;
let indexId: string;

beforeAll(async () => {
  pool = new pg.Pool({ ...DB_CONFIG, max: 2, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    available = true;
  } catch {
    available = false;
    return;
  }

  // Apply schema
  const schemaPath = join(__dirname, "../../core-service/src/storage/schema.sql");
  try {
    const sql = readFileSync(schemaPath, "utf8");
    await pool.query(sql);
  } catch {
    // schema may already be applied
  }

  // Seed a repo and index
  const repoRes = await pool.query<{ id: string }>(
    `INSERT INTO repos (org, name) VALUES ('test', 'hello-world')
     ON CONFLICT (org, name) DO UPDATE SET updated_at = NOW() RETURNING id`
  );
  repoId = repoRes.rows[0]!.id;

  const idxRes = await pool.query<{ id: string }>(
    `INSERT INTO indexes (repo_id, commit_sha, branch, uploader, tool, blob_key, status)
     VALUES ($1, 'abc123def456', 'main', 'ci', 'scip-test', 'test/blob.scip', 'pending')
     ON CONFLICT (repo_id, commit_sha, tool) DO UPDATE SET status = 'pending' RETURNING id`,
    [repoId]
  );
  indexId = idxRes.rows[0]!.id;
});

afterAll(async () => {
  if (pool) {
    // Cleanup test data
    try {
      await pool.query("DELETE FROM repos WHERE org = 'test' AND name = 'hello-world'");
    } catch {}
    await pool.end();
  }
});

describe("materialize (integration)", () => {
  it("inserts symbols and occurrences into Postgres and marks index ready", async () => {
    if (!available) {
      console.warn("Skipping — Postgres not available");
      return;
    }

    const buf = buildHelloScip();
    const parsed = await parseScip(buf);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await materialize(client, {
        indexId,
        repoId,
        commitSha: "abc123def456",
        branch: "main",
        parsed,
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    // Verify symbols
    const symRes = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM symbols WHERE index_id = $1",
      [indexId]
    );
    expect(Number(symRes.rows[0]!.count)).toBeGreaterThanOrEqual(1);

    // Verify occurrences
    const occRes = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM occurrences WHERE index_id = $1",
      [indexId]
    );
    expect(Number(occRes.rows[0]!.count)).toBeGreaterThanOrEqual(1);

    // Verify status = ready
    const idxRes = await pool.query<{ status: string }>(
      "SELECT status FROM indexes WHERE id = $1",
      [indexId]
    );
    expect(idxRes.rows[0]!.status).toBe("ready");

    // Verify repo_head was upserted
    const headRes = await pool.query<{ commit_sha: string }>(
      "SELECT commit_sha FROM repo_head WHERE repo_id = $1 AND branch = 'main'",
      [repoId]
    );
    expect(headRes.rows[0]!.commit_sha).toBe("abc123def456");
  });

  it("is idempotent — re-running materialize replaces old data without duplicates", async () => {
    if (!available) return;

    const buf = buildHelloScip();
    const parsed = await parseScip(buf);

    // Run twice
    for (let i = 0; i < 2; i++) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await materialize(client, {
          indexId,
          repoId,
          commitSha: "abc123def456",
          branch: "main",
          parsed,
        });
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    }

    const symRes = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM symbols WHERE index_id = $1",
      [indexId]
    );
    // Should equal parsed.symbols.length, not double
    expect(Number(symRes.rows[0]!.count)).toBe(parsed.symbols.length);
  });
});
