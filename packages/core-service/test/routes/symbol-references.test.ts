/**
 * Integration test for GET /v1/symbols/references?scip_symbol=...
 * Requires running Postgres with schema applied.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { buildApp } from "../helpers/build-app.js";
import { symbolReferencesRoutes } from "../../src/routes/symbol-references.js";
import type { FastifyInstance } from "fastify";

const DB_CONFIG = {
  host: process.env["POSTGRES_HOST"] ?? "localhost",
  port: Number(process.env["POSTGRES_PORT"] ?? 5432),
  database: process.env["POSTGRES_DB"] ?? "cms",
  user: process.env["POSTGRES_USER"] ?? "cms",
  password: process.env["POSTGRES_PASSWORD"] ?? "",
};

const TEST_ORG = "test-refs-route";
const TEST_REPO = "hello";
const TEST_COMMIT = "aabbccdd11112222333344445555666677778888";
const TEST_SYMBOL =
  "scip-test maven com.example:refs-test 1.0 com/example/Foo#bar().";

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

  // Seed: repo → index → symbol + occurrences
  // role=1 (DEFINITION), role=8 (READ), role=4 (WRITE)
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

  await pool.query(
    `INSERT INTO symbols
       (index_id, repo_id, commit_sha, scip_symbol, display_name, kind, language,
        file_path, start_line, start_col, end_line, end_col)
     VALUES ($1, $2, $3, $4, 'bar', 'method', 'java', 'src/Foo.java', 5, 2, 5, 5)
     ON CONFLICT DO NOTHING`,
    [indexId, repoId, TEST_COMMIT, TEST_SYMBOL]
  );

  await pool.query(
    `INSERT INTO occurrences
       (index_id, repo_id, commit_sha, scip_symbol, file_path, start_line, start_col, end_line, end_col, role)
     VALUES
       ($1, $2, $3, $4, 'src/Foo.java',  5, 2,  5, 5, 1),
       ($1, $2, $3, $4, 'src/Bar.java', 20, 0, 20, 3, 8),
       ($1, $2, $3, $4, 'src/Baz.java', 30, 1, 30, 4, 4)
     ON CONFLICT DO NOTHING`,
    [indexId, repoId, TEST_COMMIT, TEST_SYMBOL]
  );

  app = await buildApp(symbolReferencesRoutes);
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

describe("GET /v1/symbols/references", () => {
  it("returns non-definition occurrences by default (include_definitions=false)", async () => {
    if (!available) {
      console.warn("Skipping — Postgres not available");
      return;
    }

    const url = `/v1/symbols/references?scip_symbol=${encodeURIComponent(TEST_SYMBOL)}`;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(200);

    const body = res.json<{
      scip_symbol: string;
      repo: string;
      commit_sha: string;
      total: number;
      truncated: boolean;
      occurrences: Array<{ file_path: string; role: number }>;
    }>();

    expect(body.scip_symbol).toBe(TEST_SYMBOL);
    expect(body.repo).toBe(`${TEST_ORG}/${TEST_REPO}`);
    expect(typeof body.commit_sha).toBe("string");
    // Only role=8 and role=4 should be returned (definitions excluded)
    expect(body.occurrences.every((o) => (o.role & 1) === 0)).toBe(true);
    expect(body.total).toBe(2);
    expect(body.truncated).toBe(false);
    expect(body.occurrences).toHaveLength(2);
  });

  it("includes definition occurrences when include_definitions=true", async () => {
    if (!available) return;

    const url =
      `/v1/symbols/references?scip_symbol=${encodeURIComponent(TEST_SYMBOL)}` +
      `&include_definitions=true`;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(200);

    const body = res.json<{
      total: number;
      occurrences: Array<{ role: number }>;
    }>();

    expect(body.total).toBe(3);
    expect(body.occurrences.some((o) => (o.role & 1) === 1)).toBe(true);
  });

  it("returns 400 when scip_symbol is missing", async () => {
    if (!available) return;
    const res = await app.inject({
      method: "GET",
      url: "/v1/symbols/references",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("missing_scip_symbol");
  });

  it("returns 400 when limit is out of range", async () => {
    if (!available) return;
    const url =
      `/v1/symbols/references?scip_symbol=${encodeURIComponent(TEST_SYMBOL)}` +
      `&limit=9999`;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("invalid_limit");
  });

  it("returns 400 when repo format is invalid", async () => {
    if (!available) return;
    const url =
      `/v1/symbols/references?scip_symbol=${encodeURIComponent(TEST_SYMBOL)}` +
      `&repo=badformat`;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("invalid_repo");
  });

  it("returns 404 when symbol has no occurrences", async () => {
    if (!available) return;
    const url = `/v1/symbols/references?scip_symbol=${encodeURIComponent(
      "scip-test maven nonexistent."
    )}`;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe("symbol_not_found");
  });

  it("filters by repo when repo param is specified", async () => {
    if (!available) return;

    const url =
      `/v1/symbols/references?scip_symbol=${encodeURIComponent(TEST_SYMBOL)}` +
      `&repo=${encodeURIComponent(`${TEST_ORG}/${TEST_REPO}`)}`;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(200);

    const body = res.json<{ repo: string; total: number }>();
    expect(body.repo).toBe(`${TEST_ORG}/${TEST_REPO}`);
  });

  it("truncates and sets truncated=true when results exceed limit", async () => {
    if (!available) return;

    // limit=1 should truncate (we have 2 non-def occurrences)
    const url =
      `/v1/symbols/references?scip_symbol=${encodeURIComponent(TEST_SYMBOL)}` +
      `&limit=1`;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(200);

    const body = res.json<{
      total: number;
      truncated: boolean;
      occurrences: unknown[];
    }>();
    expect(body.total).toBe(2);
    expect(body.truncated).toBe(true);
    expect(body.occurrences).toHaveLength(1);
  });
});
