/**
 * Integration test for GET /v1/files/overview?repo=...&file_path=...
 * Requires running Postgres with schema applied.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { buildApp } from "../helpers/build-app.js";
import { fileOverviewRoutes } from "../../src/routes/file-overview.js";
import type { FastifyInstance } from "fastify";

const DB_CONFIG = {
  host: process.env["POSTGRES_HOST"] ?? "localhost",
  port: Number(process.env["POSTGRES_PORT"] ?? 5432),
  database: process.env["POSTGRES_DB"] ?? "cms",
  user: process.env["POSTGRES_USER"] ?? "cms",
  password: process.env["POSTGRES_PASSWORD"] ?? "",
};

const TEST_ORG = "test-file-overview";
const TEST_REPO = "hello";
const TEST_COMMIT = "cc112233445566778899aabbccddeeff00112233";
const NEWER_COMMIT_FO = "eeeeffff11223344556677889900aabbccddeeff";
const TEST_FILE = "src/com/example/OrderService.java";

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

  // Seed: repo → index → 3 symbols in the test file
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

  // Insert 3 symbols in different line order (to test ordering)
  await pool.query(
    `INSERT INTO symbols
       (index_id, repo_id, commit_sha, scip_symbol, display_name, kind, language,
        file_path, start_line, start_col, end_line, end_col)
     VALUES
       ($1, $2, $3, 'scip-test OrderService#OrderService().', 'OrderService', 'class', 'java', $4, 1, 0, 1, 12),
       ($1, $2, $3, 'scip-test OrderService#placeOrder().',   'placeOrder',   'method', 'java', $4, 10, 2, 10, 12),
       ($1, $2, $3, 'scip-test OrderService#cancelOrder().',  'cancelOrder',  'method', 'java', $4, 25, 2, 25, 13)
     ON CONFLICT DO NOTHING`,
    [indexId, repoId, TEST_COMMIT, TEST_FILE]
  );

  // NEWER_COMMIT_FO index (feature branch, newer created_at) for commit-omission tests
  const ixNewer = await pool.query<{ id: string }>(
    `INSERT INTO indexes (repo_id, commit_sha, branch, uploader, tool, status)
     VALUES ($1, $2, 'feature', 'ci', 'scip-test', 'ready')
     ON CONFLICT (repo_id, commit_sha, tool) WHERE status NOT IN ('failed', 'reclaiming') DO UPDATE SET status = 'ready' RETURNING id`,
    [repoId, NEWER_COMMIT_FO]
  );
  const newerIndexId = ixNewer.rows[0]!.id;

  // Same file symbols in NEWER_COMMIT_FO so the route returns 200 even on wrong commit
  await pool.query(
    `INSERT INTO symbols
       (index_id, repo_id, commit_sha, scip_symbol, display_name, kind, language,
        file_path, start_line, start_col, end_line, end_col)
     VALUES
       ($1, $2, $3, 'scip-test OrderService#OrderService().', 'OrderService', 'class', 'java', $4, 1, 0, 1, 12)
     ON CONFLICT DO NOTHING`,
    [newerIndexId, repoId, NEWER_COMMIT_FO, TEST_FILE]
  );

  // repo_head: main → TEST_COMMIT (default_branch), feature → NEWER_COMMIT_FO
  await pool.query(
    `INSERT INTO repo_head (repo_id, branch, commit_sha, index_id)
     VALUES ($1, 'main', $2, $3)
     ON CONFLICT (repo_id, branch) DO UPDATE
       SET commit_sha = EXCLUDED.commit_sha, index_id = EXCLUDED.index_id`,
    [repoId, TEST_COMMIT, indexId]
  );
  await pool.query(
    `INSERT INTO repo_head (repo_id, branch, commit_sha, index_id)
     VALUES ($1, 'feature', $2, $3)
     ON CONFLICT (repo_id, branch) DO UPDATE
       SET commit_sha = EXCLUDED.commit_sha, index_id = EXCLUDED.index_id`,
    [repoId, NEWER_COMMIT_FO, newerIndexId]
  );

  app = await buildApp(fileOverviewRoutes);
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

describe("GET /v1/files/overview", () => {
  it("returns symbols in the file ordered by start_line", async () => {
    if (!available) {
      console.warn("Skipping — Postgres not available");
      return;
    }

    const url =
      `/v1/files/overview?repo=${encodeURIComponent(`${TEST_ORG}/${TEST_REPO}`)}` +
      `&file_path=${encodeURIComponent(TEST_FILE)}` +
      `&commit=${encodeURIComponent(TEST_COMMIT)}`;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(200);

    const body = res.json<{
      repo: string;
      commit_sha: string;
      file_path: string;
      total: number;
      symbols: Array<{ display_name: string | null; start_line: number | null }>;
    }>();

    expect(body.repo).toBe(`${TEST_ORG}/${TEST_REPO}`);
    expect(body.file_path).toBe(TEST_FILE);
    expect(body.total).toBe(3);
    expect(body.symbols).toHaveLength(3);
    // Verify ascending start_line order
    const lines = body.symbols
      .map((s) => s.start_line)
      .filter((l): l is number => l != null);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
    expect(body.symbols[0]!.display_name).toBe("OrderService");
    expect(body.symbols[1]!.display_name).toBe("placeOrder");
  });

  it("returns 400 when repo is missing", async () => {
    if (!available) return;
    const url = `/v1/files/overview?file_path=${encodeURIComponent(TEST_FILE)}`;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("missing_repo");
  });

  it("returns 400 when file_path is missing", async () => {
    if (!available) return;
    const url = `/v1/files/overview?repo=${encodeURIComponent(`${TEST_ORG}/${TEST_REPO}`)}`;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("missing_file_path");
  });

  it("returns 400 when repo format is invalid", async () => {
    if (!available) return;
    const url =
      `/v1/files/overview?repo=badformat` +
      `&file_path=${encodeURIComponent(TEST_FILE)}`;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("invalid_repo");
  });

  it("uses commit param when specified", async () => {
    if (!available) return;
    const url =
      `/v1/files/overview?repo=${encodeURIComponent(`${TEST_ORG}/${TEST_REPO}`)}` +
      `&file_path=${encodeURIComponent(TEST_FILE)}` +
      `&commit=${encodeURIComponent(TEST_COMMIT)}`;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ commit_sha: string }>().commit_sha).toBe(TEST_COMMIT);
  });

  it("returns 404 when repo does not exist", async () => {
    if (!available) return;
    const url =
      `/v1/files/overview?repo=nonexistent/repo` +
      `&file_path=${encodeURIComponent(TEST_FILE)}`;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe("repo_not_found");
  });

  it("returns 404 when file has no indexed symbols", async () => {
    if (!available) return;
    const url =
      `/v1/files/overview?repo=${encodeURIComponent(`${TEST_ORG}/${TEST_REPO}`)}` +
      `&file_path=${encodeURIComponent("src/NonExistent.java")}`;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe("file_not_indexed");
  });

  it("resolves omitted commit via repo_head(default_branch), not latest created_at", async () => {
    if (!available) return;
    // NEWER_COMMIT_FO is on 'feature' branch with a later created_at.
    // repo_head(main) points to TEST_COMMIT.
    // Omitting commit must return TEST_COMMIT, not NEWER_COMMIT_FO.
    const url =
      `/v1/files/overview?repo=${encodeURIComponent(`${TEST_ORG}/${TEST_REPO}`)}` +
      `&file_path=${encodeURIComponent(TEST_FILE)}`;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ commit_sha: string }>().commit_sha).toBe(TEST_COMMIT);
  });
});
