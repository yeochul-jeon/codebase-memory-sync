/**
 * Integration test: materialize() inserts ParsedRelationship rows
 * into symbol_relationships table.
 *
 * Requires running Postgres with schema applied.
 * Skip gracefully if unavailable.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { materialize } from "../src/materialize.js";
import type { ParsedIndex } from "../src/parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DB_CONFIG = {
  host: process.env["POSTGRES_HOST"] ?? "localhost",
  port: Number(process.env["POSTGRES_PORT"] ?? 5432),
  database: process.env["POSTGRES_DB"] ?? "cms",
  user: process.env["POSTGRES_USER"] ?? "cms",
  password: process.env["POSTGRES_PASSWORD"] ?? "",
};

const TEST_ORG = "test-mat-rels";
const TEST_REPO = "reltest";
const TEST_COMMIT = "bbccddee11223344556677889900aabbccddeeff";
const FROM_SYM = "scip-java maven com.example:app 1.0 com/example/FooImpl#.";
const TO_SYM = "scip-java maven com.example:app 1.0 com/example/IFoo#.";

let pool: pg.Pool;
let available = false;
let repoId: string;
let indexId: string;

const parsedWithRelationships: ParsedIndex = {
  symbols: [],
  occurrences: [],
  relationships: [
    {
      from_symbol: FROM_SYM,
      to_symbol: TO_SYM,
      is_reference: false,
      is_implementation: true,
      is_type_definition: false,
      is_definition: false,
    },
  ],
};

beforeAll(async () => {
  pool = new pg.Pool({ ...DB_CONFIG, max: 2, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    available = true;
  } catch {
    available = false;
    return;
  }

  // Apply schema (idempotent)
  const schemaPath = join(__dirname, "../../core-service/src/storage/schema.sql");
  try {
    const sql = readFileSync(schemaPath, "utf8");
    await pool.query(sql);
  } catch {
    // already applied
  }

  // Seed repo + index
  const r = await pool.query<{ id: string }>(
    `INSERT INTO repos (org, name) VALUES ($1, $2)
     ON CONFLICT (org, name) DO UPDATE SET updated_at = NOW() RETURNING id`,
    [TEST_ORG, TEST_REPO]
  );
  repoId = r.rows[0]!.id;

  const ix = await pool.query<{ id: string }>(
    `INSERT INTO indexes (repo_id, commit_sha, branch, uploader, tool, blob_key, status)
     VALUES ($1, $2, 'main', 'ci', 'scip-test', 'test/rel.scip', 'pending')
     ON CONFLICT (repo_id, commit_sha, tool) WHERE status NOT IN ('failed', 'reclaiming') DO UPDATE SET status = 'pending' RETURNING id`,
    [repoId, TEST_COMMIT]
  );
  indexId = ix.rows[0]!.id;
});

afterAll(async () => {
  if (pool) {
    try {
      await pool.query("DELETE FROM repos WHERE org = $1 AND name = $2", [TEST_ORG, TEST_REPO]);
    } catch {}
    await pool.end();
  }
});

describe("materialize — relationships (integration)", () => {
  it("inserts relationship rows into symbol_relationships", async () => {
    if (!available) {
      console.warn("Skipping — Postgres not available");
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await materialize(client, {
        indexId,
        repoId,
        commitSha: TEST_COMMIT,
        branch: "main",
        parsed: parsedWithRelationships,
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    const res = await pool.query<{
      from_symbol: string;
      to_symbol: string;
      is_implementation: boolean;
    }>(
      `SELECT from_symbol, to_symbol, is_implementation
       FROM symbol_relationships WHERE index_id = $1`,
      [indexId]
    );

    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.from_symbol).toBe(FROM_SYM);
    expect(res.rows[0]!.to_symbol).toBe(TO_SYM);
    expect(res.rows[0]!.is_implementation).toBe(true);
  });

  it("clears old relationships on re-materialize (idempotent)", async () => {
    if (!available) return;

    // Run materialize twice — should still have exactly 1 row
    for (let i = 0; i < 2; i++) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await materialize(client, {
          indexId,
          repoId,
          commitSha: TEST_COMMIT,
          branch: "main",
          parsed: parsedWithRelationships,
        });
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    }

    const res = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM symbol_relationships WHERE index_id = $1",
      [indexId]
    );
    expect(Number(res.rows[0]!.count)).toBe(1);
  });
});
