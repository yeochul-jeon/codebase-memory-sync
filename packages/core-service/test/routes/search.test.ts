/**
 * Integration test for GET /v1/search — existing route + kind filter extension.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { buildApp } from "../helpers/build-app.js";
import { searchRoutes } from "../../src/routes/search.js";
import type { FastifyInstance } from "fastify";

const DB_CONFIG = {
  host: process.env["POSTGRES_HOST"] ?? "localhost",
  port: Number(process.env["POSTGRES_PORT"] ?? 5432),
  database: process.env["POSTGRES_DB"] ?? "cms",
  user: process.env["POSTGRES_USER"] ?? "cms",
  password: process.env["POSTGRES_PASSWORD"] ?? "",
};

const TEST_ORG = "test-search-route";
const TEST_REPO = "app";
const TEST_COMMIT = "cafebabe11112222333344445555666677778888";

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

  // Insert 2 symbols: one method, one class — both named "Widget*"
  await pool.query(
    `INSERT INTO symbols
       (index_id, repo_id, commit_sha, scip_symbol, display_name, kind, language, file_path, start_line, start_col, end_line, end_col)
     VALUES
       ($1, $2, $3, 'scip-test . Widget#init().', 'WidgetInit', 'method', 'java', 'src/Widget.java', 5, 2, 6, 3),
       ($1, $2, $3, 'scip-test . Widget#.', 'WidgetClass', 'class', 'java', 'src/Widget.java', 1, 0, 50, 1)
     ON CONFLICT DO NOTHING`,
    [indexId, repoId, TEST_COMMIT]
  );

  app = await buildApp(searchRoutes);
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

describe("GET /v1/search", () => {
  it("returns 400 when q is missing", async () => {
    if (!available) { console.warn("Skipping — Postgres not available"); return; }
    const res = await app.inject({ method: "GET", url: "/v1/search" });
    expect(res.statusCode).toBe(400);
  });

  it("returns results matching display_name prefix", async () => {
    if (!available) return;
    const res = await app.inject({ method: "GET", url: "/v1/search?q=Widget" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ results: Array<{ display_name: string }> }>();
    expect(body.results.length).toBeGreaterThanOrEqual(2);
  });

  it("filters by kind=method, excluding class results", async () => {
    if (!available) return;
    const res = await app.inject({ method: "GET", url: "/v1/search?q=Widget&kind=method" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ results: Array<{ display_name: string; kind: string }> }>();
    // All results must be method kind
    expect(body.results.every(r => r.kind === "method")).toBe(true);
    // WidgetInit should be present
    expect(body.results.some(r => r.display_name === "WidgetInit")).toBe(true);
    // WidgetClass should NOT be present
    expect(body.results.some(r => r.display_name === "WidgetClass")).toBe(false);
  });

  it("filters by repo org/name", async () => {
    if (!available) return;
    const res = await app.inject({
      method: "GET",
      url: `/v1/search?q=Widget&repo=${TEST_ORG}/${TEST_REPO}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ results: unknown[] }>();
    expect(body.results.length).toBeGreaterThanOrEqual(2);
  });
});
