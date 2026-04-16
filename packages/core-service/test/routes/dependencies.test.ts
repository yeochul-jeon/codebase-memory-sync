/**
 * Integration test for GET /v1/symbols/dependencies?scip_symbol=...
 * Requires running Postgres with schema applied.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { buildApp } from "../helpers/build-app.js";
import { dependenciesRoutes } from "../../src/routes/dependencies.js";
import type { FastifyInstance } from "fastify";

const DB_CONFIG = {
  host: process.env["POSTGRES_HOST"] ?? "localhost",
  port: Number(process.env["POSTGRES_PORT"] ?? 5432),
  database: process.env["POSTGRES_DB"] ?? "cms",
  user: process.env["POSTGRES_USER"] ?? "cms",
  password: process.env["POSTGRES_PASSWORD"] ?? "",
};

const TEST_ORG = "test-dependencies";
const TEST_REPO = "deptest";
const TEST_COMMIT = "ddeeff0011223344556677889900aabbccddeeff";
const FROM_SYMBOL =
  "scip-java maven com.example:app 1.0 com/example/OrderService#.";
const DEP_A =
  "scip-java maven com.example:app 1.0 com/example/IPayment#.";
const DEP_B =
  "scip-java maven com.example:app 1.0 com/example/Inventory#.";

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
     ON CONFLICT (repo_id, commit_sha, tool) DO UPDATE SET status = 'ready' RETURNING id`,
    [repoId, TEST_COMMIT]
  );
  const indexId = ix.rows[0]!.id;

  // Seed target symbols
  await pool.query(
    `INSERT INTO symbols
       (index_id, repo_id, commit_sha, scip_symbol, display_name, kind, language,
        file_path, start_line, start_col, end_line, end_col)
     VALUES
       ($1, $2, $3, $4, 'IPayment', 'interface', 'java', 'src/IPayment.java', 1, 0, 1, 8),
       ($1, $2, $3, $5, 'Inventory', 'class', 'java', 'src/Inventory.java', 1, 0, 1, 9)
     ON CONFLICT DO NOTHING`,
    [indexId, repoId, TEST_COMMIT, DEP_A, DEP_B]
  );

  // Seed relationships: FROM_SYMBOL depends on DEP_A (type_def) and DEP_B (reference)
  await pool.query(
    `INSERT INTO symbol_relationships
       (index_id, repo_id, commit_sha, from_symbol, to_symbol,
        is_reference, is_implementation, is_type_definition, is_definition)
     VALUES
       ($1, $2, $3, $4, $5, false, false, true, false),
       ($1, $2, $3, $4, $6, true, false, false, false)
     ON CONFLICT DO NOTHING`,
    [indexId, repoId, TEST_COMMIT, FROM_SYMBOL, DEP_A, DEP_B]
  );

  app = await buildApp(dependenciesRoutes);
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

describe("GET /v1/symbols/dependencies", () => {
  it("returns direct dependencies for a given symbol", async () => {
    if (!available) {
      console.warn("Skipping — Postgres not available");
      return;
    }

    const url = `/v1/symbols/dependencies?scip_symbol=${encodeURIComponent(FROM_SYMBOL)}`;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(200);

    const body = res.json<{
      scip_symbol: string;
      total: number;
      truncated: boolean;
      dependencies: Array<{
        to_symbol: string;
        display_name: string | null;
        kind: string | null;
        is_reference: boolean;
        is_type_definition: boolean;
        repo: string;
        commit_sha: string;
      }>;
    }>();

    expect(body.scip_symbol).toBe(FROM_SYMBOL);
    expect(body.total).toBe(2);
    expect(body.truncated).toBe(false);
    expect(body.dependencies).toHaveLength(2);

    const depA = body.dependencies.find((d) => d.to_symbol === DEP_A)!;
    expect(depA).toBeDefined();
    expect(depA.is_type_definition).toBe(true);
    expect(depA.is_reference).toBe(false);

    const depB = body.dependencies.find((d) => d.to_symbol === DEP_B)!;
    expect(depB).toBeDefined();
    expect(depB.is_reference).toBe(true);
  });

  it("returns 400 when scip_symbol is missing", async () => {
    if (!available) return;
    const res = await app.inject({ method: "GET", url: "/v1/symbols/dependencies" });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("missing_scip_symbol");
  });

  it("returns 400 when limit is out of range", async () => {
    if (!available) return;
    const url =
      `/v1/symbols/dependencies?scip_symbol=${encodeURIComponent(FROM_SYMBOL)}` +
      `&limit=9999`;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("invalid_limit");
  });

  it("returns 400 when repo format is invalid", async () => {
    if (!available) return;
    const url =
      `/v1/symbols/dependencies?scip_symbol=${encodeURIComponent(FROM_SYMBOL)}` +
      `&repo=badformat`;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("invalid_repo");
  });

  it("returns 404 when no dependencies exist", async () => {
    if (!available) return;
    const url = `/v1/symbols/dependencies?scip_symbol=${encodeURIComponent(
      "scip-java maven nonexistent."
    )}`;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe("symbol_not_found");
  });

  it("filters by repo when repo param is specified", async () => {
    if (!available) return;
    const url =
      `/v1/symbols/dependencies?scip_symbol=${encodeURIComponent(FROM_SYMBOL)}` +
      `&repo=${encodeURIComponent(`${TEST_ORG}/${TEST_REPO}`)}`;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ total: number }>().total).toBe(2);
  });

  it("truncates and sets truncated=true when results exceed limit", async () => {
    if (!available) return;
    const url =
      `/v1/symbols/dependencies?scip_symbol=${encodeURIComponent(FROM_SYMBOL)}` +
      `&limit=1`;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      total: number;
      truncated: boolean;
      dependencies: unknown[];
    }>();
    expect(body.total).toBe(2);
    expect(body.truncated).toBe(true);
    expect(body.dependencies).toHaveLength(1);
  });
});
