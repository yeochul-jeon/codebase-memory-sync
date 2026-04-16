/**
 * Integration test for GET /v1/repos
 * Requires running Postgres. env vars injected via vitest.config.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { buildApp } from "../helpers/build-app.js";
import { reposRoutes } from "../../src/routes/repos.js";
import type { FastifyInstance } from "fastify";

const DB_CONFIG = {
  host: process.env["POSTGRES_HOST"] ?? "localhost",
  port: Number(process.env["POSTGRES_PORT"] ?? 5432),
  database: process.env["POSTGRES_DB"] ?? "cms",
  user: process.env["POSTGRES_USER"] ?? "cms",
  password: process.env["POSTGRES_PASSWORD"] ?? "",
};

let pool: pg.Pool;
let app: FastifyInstance;
let available = false;
let repoId: string;
let indexId: string;

const TEST_ORG = "test-repos-route";
const TEST_REPO = "sample";

beforeAll(async () => {
  pool = new pg.Pool({ ...DB_CONFIG, max: 2, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    available = true;
  } catch {
    available = false;
    return;
  }

  // Seed a repo + index + head
  const r = await pool.query<{ id: string }>(
    `INSERT INTO repos (org, name, primary_lang, default_branch)
     VALUES ($1, $2, 'java', 'main')
     ON CONFLICT (org, name) DO UPDATE SET updated_at = NOW() RETURNING id`,
    [TEST_ORG, TEST_REPO]
  );
  repoId = r.rows[0]!.id;

  const ix = await pool.query<{ id: string }>(
    `INSERT INTO indexes (repo_id, commit_sha, branch, uploader, tool, status)
     VALUES ($1, 'aabbccdd1234', 'main', 'ci', 'scip-java', 'ready')
     ON CONFLICT (repo_id, commit_sha, tool) DO UPDATE SET status = 'ready' RETURNING id`,
    [repoId]
  );
  indexId = ix.rows[0]!.id;

  await pool.query(
    `INSERT INTO repo_head (repo_id, branch, commit_sha, index_id)
     VALUES ($1, 'main', 'aabbccdd1234', $2)
     ON CONFLICT (repo_id, branch) DO UPDATE SET commit_sha = EXCLUDED.commit_sha, index_id = EXCLUDED.index_id`,
    [repoId, indexId]
  );

  app = await buildApp(reposRoutes);
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

describe("GET /v1/repos", () => {
  it("returns 200 with a list of repos including seeded repo", async () => {
    if (!available) { console.warn("Skipping — Postgres not available"); return; }

    const res = await app.inject({ method: "GET", url: "/v1/repos" });
    expect(res.statusCode).toBe(200);

    const body = res.json<{ repos: Array<{ org: string; name: string; default_branch: string; primary_lang: string; heads: unknown[] }> }>();
    expect(Array.isArray(body.repos)).toBe(true);

    const found = body.repos.find(r => r.org === TEST_ORG && r.name === TEST_REPO);
    expect(found).toBeDefined();
    expect(found?.default_branch).toBe("main");
    expect(found?.primary_lang).toBe("java");
    expect(Array.isArray(found?.heads)).toBe(true);
    expect(found?.heads.length).toBeGreaterThanOrEqual(1);
  });

  it("returns repos sorted by org then name", async () => {
    if (!available) return;
    const res = await app.inject({ method: "GET", url: "/v1/repos" });
    const body = res.json<{ repos: Array<{ org: string; name: string }> }>();
    const names = body.repos.map(r => `${r.org}/${r.name}`);
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });
});
