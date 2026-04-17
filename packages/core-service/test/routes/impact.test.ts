/**
 * Integration test for GET /v1/symbols/impact?scip_symbol=...
 * Tests recursive dependency graph traversal (impact analysis).
 * Requires running Postgres with schema applied.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { buildApp } from "../helpers/build-app.js";
import { impactRoutes } from "../../src/routes/impact.js";
import type { FastifyInstance } from "fastify";

const DB_CONFIG = {
  host: process.env["POSTGRES_HOST"] ?? "localhost",
  port: Number(process.env["POSTGRES_PORT"] ?? 5432),
  database: process.env["POSTGRES_DB"] ?? "cms",
  user: process.env["POSTGRES_USER"] ?? "cms",
  password: process.env["POSTGRES_PASSWORD"] ?? "",
};

const TEST_ORG = "test-impact";
const TEST_REPO = "impacttest";
const TEST_COMMIT = "eeff0011223344556677889900aabbccddeeff00";

// Chain: IFoo ← FooImpl ← FooService ← FooController
const SYM_IFOO = "scip-java maven com.example:app 1.0 com/example/IFoo#.";
const SYM_IMPL = "scip-java maven com.example:app 1.0 com/example/FooImpl#.";
const SYM_SVC = "scip-java maven com.example:app 1.0 com/example/FooService#.";
const SYM_CTRL = "scip-java maven com.example:app 1.0 com/example/FooController#.";

let pool: pg.Pool;
let app: FastifyInstance;
let available = false;

beforeAll(async () => {
  pool = new pg.Pool({ ...DB_CONFIG, max: 2, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    available = true;
  } catch {
    available = false;
    return;
  }

  const r = await pool.query<{ id: string }>(
    `INSERT INTO repos (org, name, primary_lang) VALUES ($1, $2, 'java')
     ON CONFLICT (org, name) DO UPDATE SET updated_at = NOW() RETURNING id`,
    [TEST_ORG, TEST_REPO]
  );
  const repoId = r.rows[0]!.id;

  const ix = await pool.query<{ id: string }>(
    `INSERT INTO indexes (repo_id, commit_sha, branch, uploader, tool, status)
     VALUES ($1, $2, 'main', 'ci', 'scip-test', 'ready')
     ON CONFLICT (repo_id, commit_sha, tool) WHERE status NOT IN ('failed', 'reclaiming') DO UPDATE SET status = 'ready' RETURNING id`,
    [repoId, TEST_COMMIT]
  );
  const indexId = ix.rows[0]!.id;

  // Chain relationships:
  //   FooImpl → IFoo (depth 1 from IFoo)
  //   FooService → FooImpl (depth 2 from IFoo)
  //   FooController → FooService (depth 3 from IFoo)
  await pool.query(
    `INSERT INTO symbol_relationships
       (index_id, repo_id, commit_sha, from_symbol, to_symbol,
        is_reference, is_implementation, is_type_definition, is_definition)
     VALUES
       ($1, $2, $3, $4, $5, false, true, false, false),
       ($1, $2, $3, $6, $4, true, false, false, false),
       ($1, $2, $3, $7, $6, true, false, false, false)
     ON CONFLICT DO NOTHING`,
    [indexId, repoId, TEST_COMMIT, SYM_IMPL, SYM_IFOO, SYM_SVC, SYM_CTRL]
  );

  app = await buildApp(impactRoutes);
});

afterAll(async () => {
  if (pool) {
    try {
      await pool.query("DELETE FROM repos WHERE org = $1 AND name = $2", [
        TEST_ORG,
        TEST_REPO,
      ]);
    } catch {}
    await pool.end();
  }
  if (app) await app.close();
});

describe("GET /v1/symbols/impact", () => {
  it("returns depth-1 impacted symbols", async () => {
    if (!available) {
      console.warn("Skipping — Postgres not available");
      return;
    }

    const url =
      `/v1/symbols/impact?scip_symbol=${encodeURIComponent(SYM_IFOO)}` +
      `&depth=1`;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(200);

    const body = res.json<{
      scip_symbol: string;
      depth: number;
      total: number;
      truncated: boolean;
      impacted: Array<{ symbol: string; depth: number }>;
    }>();

    expect(body.scip_symbol).toBe(SYM_IFOO);
    expect(body.depth).toBe(1);
    expect(body.total).toBe(1);
    const syms = body.impacted.map((x) => x.symbol);
    expect(syms).toContain(SYM_IMPL);
    expect(syms).not.toContain(SYM_SVC);
  });

  it("returns depth-3 impacted symbols (full chain)", async () => {
    if (!available) return;

    const url =
      `/v1/symbols/impact?scip_symbol=${encodeURIComponent(SYM_IFOO)}` +
      `&depth=3`;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(200);

    const body = res.json<{
      total: number;
      impacted: Array<{ symbol: string; depth: number }>;
    }>();

    expect(body.total).toBe(3);
    const syms = body.impacted.map((x) => x.symbol);
    expect(syms).toContain(SYM_IMPL);
    expect(syms).toContain(SYM_SVC);
    expect(syms).toContain(SYM_CTRL);
  });

  it("returns 400 when scip_symbol is missing", async () => {
    if (!available) return;
    const res = await app.inject({ method: "GET", url: "/v1/symbols/impact" });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("missing_scip_symbol");
  });

  it("returns 400 when depth is out of range", async () => {
    if (!available) return;
    const url =
      `/v1/symbols/impact?scip_symbol=${encodeURIComponent(SYM_IFOO)}` +
      `&depth=10`;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("invalid_depth");
  });

  it("returns 400 when limit is out of range", async () => {
    if (!available) return;
    const url =
      `/v1/symbols/impact?scip_symbol=${encodeURIComponent(SYM_IFOO)}` +
      `&limit=9999`;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("invalid_limit");
  });

  it("returns 400 when repo format is invalid", async () => {
    if (!available) return;
    const url =
      `/v1/symbols/impact?scip_symbol=${encodeURIComponent(SYM_IFOO)}` +
      `&repo=badformat`;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("invalid_repo");
  });

  it("returns 404 when symbol has no dependents", async () => {
    if (!available) return;
    const url = `/v1/symbols/impact?scip_symbol=${encodeURIComponent(
      "scip-java maven nonexistent."
    )}`;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe("symbol_not_found");
  });

  it("handles cycle detection without infinite loop", async () => {
    if (!available) return;

    // Insert a cycle: A → B → A
    const r = await pool.query<{ id: string }>(
      "SELECT id FROM repos WHERE org = $1 AND name = $2",
      [TEST_ORG, TEST_REPO]
    );
    const repoId = r.rows[0]!.id;
    const ix = await pool.query<{ id: string }>(
      "SELECT id FROM indexes WHERE repo_id = $1",
      [repoId]
    );
    const indexId = ix.rows[0]!.id;

    const SYM_A = "scip-java maven cycle:test 1.0 A#.";
    const SYM_B = "scip-java maven cycle:test 1.0 B#.";
    await pool.query(
      `INSERT INTO symbol_relationships
         (index_id, repo_id, commit_sha, from_symbol, to_symbol,
          is_reference, is_implementation, is_type_definition, is_definition)
       VALUES
         ($1, $2, $3, $4, $5, true, false, false, false),
         ($1, $2, $3, $5, $4, true, false, false, false)
       ON CONFLICT DO NOTHING`,
      [indexId, repoId, TEST_COMMIT, SYM_A, SYM_B]
    );

    // Should complete without timing out
    const url = `/v1/symbols/impact?scip_symbol=${encodeURIComponent(SYM_A)}&depth=5`;
    const res = await app.inject({ method: "GET", url });
    expect([200, 404]).toContain(res.statusCode);
  });
});
