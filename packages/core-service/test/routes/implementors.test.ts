/**
 * Integration test for GET /v1/symbols/implementors?scip_symbol=...
 * Requires running Postgres with schema applied.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { buildApp } from "../helpers/build-app.js";
import { implementorsRoutes } from "../../src/routes/implementors.js";
import type { FastifyInstance } from "fastify";

const DB_CONFIG = {
  host: process.env["POSTGRES_HOST"] ?? "localhost",
  port: Number(process.env["POSTGRES_PORT"] ?? 5432),
  database: process.env["POSTGRES_DB"] ?? "cms",
  user: process.env["POSTGRES_USER"] ?? "cms",
  password: process.env["POSTGRES_PASSWORD"] ?? "",
};

const TEST_ORG = "test-implementors";
const TEST_REPO = "reltest";
const TEST_COMMIT = "ccddee001122334455667788990011aabbccddee";
const INTERFACE_SYMBOL =
  "scip-java maven com.example:app 1.0 com/example/IOrderService#.";
const IMPL_SYMBOL =
  "scip-java maven com.example:app 1.0 com/example/OrderServiceImpl#.";

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

  // Seed: repo → index → symbol + relationship
  const r = await pool.query<{ id: string }>(
    `INSERT INTO repos (org, name, primary_lang) VALUES ($1, $2, 'java')
     ON CONFLICT (org, name) DO UPDATE SET updated_at = NOW() RETURNING id`,
    [TEST_ORG, TEST_REPO]
  );
  const repoId = r.rows[0]!.id;

  const ix = await pool.query<{ id: string }>(
    `INSERT INTO indexes (repo_id, commit_sha, branch, uploader, tool, status)
     VALUES ($1, $2, 'main', 'ci', 'scip-test', 'ready')
     ON CONFLICT (repo_id, commit_sha, tool) DO UPDATE SET status = 'ready' RETURNING id`,
    [repoId, TEST_COMMIT]
  );
  const indexId = ix.rows[0]!.id;

  // Seed implementing symbol
  await pool.query(
    `INSERT INTO symbols
       (index_id, repo_id, commit_sha, scip_symbol, display_name, kind, language,
        file_path, start_line, start_col, end_line, end_col)
     VALUES ($1, $2, $3, $4, 'OrderServiceImpl', 'class', 'java',
             'src/OrderServiceImpl.java', 5, 0, 5, 16)
     ON CONFLICT DO NOTHING`,
    [indexId, repoId, TEST_COMMIT, IMPL_SYMBOL]
  );

  // Seed relationship: IMPL_SYMBOL implements INTERFACE_SYMBOL
  await pool.query(
    `INSERT INTO symbol_relationships
       (index_id, repo_id, commit_sha, from_symbol, to_symbol,
        is_reference, is_implementation, is_type_definition, is_definition)
     VALUES ($1, $2, $3, $4, $5, false, true, false, false)
     ON CONFLICT DO NOTHING`,
    [indexId, repoId, TEST_COMMIT, IMPL_SYMBOL, INTERFACE_SYMBOL]
  );

  app = await buildApp(implementorsRoutes);
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

describe("GET /v1/symbols/implementors", () => {
  it("returns implementors for a given interface symbol", async () => {
    if (!available) {
      console.warn("Skipping — Postgres not available");
      return;
    }

    const url = `/v1/symbols/implementors?scip_symbol=${encodeURIComponent(INTERFACE_SYMBOL)}`;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(200);

    const body = res.json<{
      scip_symbol: string;
      total: number;
      truncated: boolean;
      implementors: Array<{
        from_symbol: string;
        display_name: string | null;
        kind: string | null;
        file_path: string | null;
        start_line: number | null;
        repo: string;
        commit_sha: string;
      }>;
    }>();

    expect(body.scip_symbol).toBe(INTERFACE_SYMBOL);
    expect(body.total).toBe(1);
    expect(body.truncated).toBe(false);
    expect(body.implementors).toHaveLength(1);
    expect(body.implementors[0]!.from_symbol).toBe(IMPL_SYMBOL);
    expect(body.implementors[0]!.display_name).toBe("OrderServiceImpl");
    expect(body.implementors[0]!.kind).toBe("class");
    expect(body.implementors[0]!.repo).toBe(`${TEST_ORG}/${TEST_REPO}`);
  });

  it("returns 400 when scip_symbol is missing", async () => {
    if (!available) return;
    const res = await app.inject({ method: "GET", url: "/v1/symbols/implementors" });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("missing_scip_symbol");
  });

  it("returns 400 when limit is out of range", async () => {
    if (!available) return;
    const url =
      `/v1/symbols/implementors?scip_symbol=${encodeURIComponent(INTERFACE_SYMBOL)}` +
      `&limit=9999`;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("invalid_limit");
  });

  it("returns 400 when repo format is invalid", async () => {
    if (!available) return;
    const url =
      `/v1/symbols/implementors?scip_symbol=${encodeURIComponent(INTERFACE_SYMBOL)}` +
      `&repo=badformat`;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("invalid_repo");
  });

  it("returns 404 when no implementors exist", async () => {
    if (!available) return;
    const url = `/v1/symbols/implementors?scip_symbol=${encodeURIComponent(
      "scip-java maven nonexistent."
    )}`;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe("symbol_not_found");
  });

  it("filters by repo when repo param is specified", async () => {
    if (!available) return;
    const url =
      `/v1/symbols/implementors?scip_symbol=${encodeURIComponent(INTERFACE_SYMBOL)}` +
      `&repo=${encodeURIComponent(`${TEST_ORG}/${TEST_REPO}`)}`;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ total: number }>();
    expect(body.total).toBe(1);
  });

  it("truncates and sets truncated=true when results exceed limit", async () => {
    if (!available) return;
    // Insert a second implementor
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

    const IMPL2 = "scip-java maven com.example:app 1.0 com/example/AnotherImpl#.";
    await pool.query(
      `INSERT INTO symbol_relationships
         (index_id, repo_id, commit_sha, from_symbol, to_symbol,
          is_reference, is_implementation, is_type_definition, is_definition)
       VALUES ($1, $2, $3, $4, $5, false, true, false, false)
       ON CONFLICT DO NOTHING`,
      [indexId, repoId, TEST_COMMIT, IMPL2, INTERFACE_SYMBOL]
    );

    const url =
      `/v1/symbols/implementors?scip_symbol=${encodeURIComponent(INTERFACE_SYMBOL)}` +
      `&limit=1`;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(200);

    const body = res.json<{
      total: number;
      truncated: boolean;
      implementors: unknown[];
    }>();
    expect(body.total).toBe(2);
    expect(body.truncated).toBe(true);
    expect(body.implementors).toHaveLength(1);
  });
});
