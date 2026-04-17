/**
 * Integration test for GET /v1/symbols?scip_symbol=...
 * Requires running Postgres with Phase-0 e2e data seeded.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { buildApp } from "../helpers/build-app.js";
import { symbolsRoutes } from "../../src/routes/symbols.js";
import type { FastifyInstance } from "fastify";

const DB_CONFIG = {
  host: process.env["POSTGRES_HOST"] ?? "localhost",
  port: Number(process.env["POSTGRES_PORT"] ?? 5432),
  database: process.env["POSTGRES_DB"] ?? "cms",
  user: process.env["POSTGRES_USER"] ?? "cms",
  password: process.env["POSTGRES_PASSWORD"] ?? "",
};

const TEST_ORG = "test-symbols-route";
const TEST_REPO = "hello";
const TEST_COMMIT = "deadbeef11112222333344445555666677778888";
const TEST_SYMBOL = "scip-test maven com.example:symbols-test 1.0 com/example/Foo#bar().";

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

  // Seed repo → index → symbol + occurrence
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

  await pool.query(
    `INSERT INTO symbols
       (index_id, repo_id, commit_sha, scip_symbol, display_name, kind, language, file_path, start_line, start_col, end_line, end_col)
     VALUES ($1, $2, $3, $4, 'bar', 'method', 'java', 'src/Foo.java', 10, 2, 11, 3)
     ON CONFLICT DO NOTHING`,
    [indexId, repoId, TEST_COMMIT, TEST_SYMBOL]
  );

  await pool.query(
    `INSERT INTO occurrences
       (index_id, repo_id, commit_sha, scip_symbol, file_path, start_line, start_col, end_line, end_col, role)
     VALUES ($1, $2, $3, $4, 'src/Foo.java', 10, 2, 11, 3, 1),
            ($1, $2, $3, $4, 'src/Bar.java', 20, 0, 20, 15, 8)
     ON CONFLICT DO NOTHING`,
    [indexId, repoId, TEST_COMMIT, TEST_SYMBOL]
  );

  app = await buildApp(symbolsRoutes);
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

describe("GET /v1/symbols", () => {
  it("returns 200 with symbol metadata and occurrences for known scip_symbol", async () => {
    if (!available) { console.warn("Skipping — Postgres not available"); return; }

    const url = `/v1/symbols?scip_symbol=${encodeURIComponent(TEST_SYMBOL)}`;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(200);

    const body = res.json<{
      symbol: { scip_symbol: string; display_name: string; kind: string; language: string; file_path: string };
      repo: string;
      commit_sha: string;
      occurrences: Array<{ file_path: string; role: number }>;
    }>();

    expect(body.symbol.scip_symbol).toBe(TEST_SYMBOL);
    expect(body.symbol.display_name).toBe("bar");
    expect(body.symbol.kind).toBe("method");
    expect(body.symbol.language).toBe("java");
    expect(Array.isArray(body.occurrences)).toBe(true);
    expect(body.occurrences.length).toBeGreaterThanOrEqual(1);
  });

  it("returns 400 when scip_symbol is missing", async () => {
    if (!available) return;
    const res = await app.inject({ method: "GET", url: "/v1/symbols" });
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 when scip_symbol is unknown", async () => {
    if (!available) return;
    const url = `/v1/symbols?scip_symbol=${encodeURIComponent("scip-unknown nonexistent.")}`;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(404);
  });
});
