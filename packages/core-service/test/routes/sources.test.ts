/**
 * Integration tests for GET /v1/sources/file and GET /v1/sources/symbol.
 *
 * Requires Postgres. MinIO is mocked.
 * Skip gracefully if Postgres unavailable.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import AdmZip from "adm-zip";

vi.mock("../../src/storage/minio.js", () => ({
  putScipBlob: vi.fn().mockResolvedValue(undefined),
  putSourceBlob: vi.fn().mockResolvedValue(undefined),
  getScipBlob: vi.fn(),
  getSourceBlob: vi.fn(),
  extractZipEntry: vi.fn(),
  getSourceZipEntry: vi.fn(),
  ensureBucket: vi.fn().mockResolvedValue(undefined),
  checkMinioHealth: vi.fn().mockResolvedValue(true),
}));

import { buildApp } from "../helpers/build-app.js";
import { sourcesRoutes } from "../../src/routes/sources.js";
import { getSourceZipEntry } from "../../src/storage/minio.js";

const DB_CONFIG = {
  host: process.env["POSTGRES_HOST"] ?? "localhost",
  port: Number(process.env["POSTGRES_PORT"] ?? 5432),
  database: process.env["POSTGRES_DB"] ?? "cms",
  user: process.env["POSTGRES_USER"] ?? "cms",
  password: process.env["POSTGRES_PASSWORD"] ?? "",
};

const TEST_ORG = "test-sources-route";
const TEST_REPO = "srcapp";
const TEST_COMMIT = "aabb11223344556677889900aabbccddeeff1122";
const NEWER_COMMIT = "ddddeeee11223344556677889900aabbccddeeff";
const TEST_SYMBOL = "scip-java maven com.example:srcapp 1.0 com/example/Foo#bar().";
const FALLBACK_SYMBOL = "scip-java maven com.example:srcapp 1.0 com/example/Foo#x.";
const BOUNDARY_SYMBOL = "scip-java maven com.example:srcapp 1.0 com/example/Foo#.";
const JAVA_CONTENT = [
  "package com.example;",
  "",
  "public class Foo {",
  "    // field",
  "    private int x;",
  "",
  "    public void bar() {",
  "        System.out.println(x);",
  "    }",
  "}",
].join("\n");

let pool: pg.Pool;
let app: FastifyInstance;
let available = false;

function buildSourceZip(content: string): Buffer {
  const zip = new AdmZip();
  zip.addFile("src/Foo.java", Buffer.from(content, "utf8"));
  return zip.toBuffer();
}

beforeAll(async () => {
  pool = new pg.Pool({ ...DB_CONFIG, max: 2, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    available = true;
  } catch {
    available = false;
    return;
  }

  // Seed data
  const r = await pool.query<{ id: string }>(
    `INSERT INTO repos (org, name) VALUES ($1, $2)
     ON CONFLICT (org, name) DO UPDATE SET updated_at = NOW() RETURNING id`,
    [TEST_ORG, TEST_REPO]
  );
  const repoId = r.rows[0]!.id;

  const sourceBlobKey = `${TEST_ORG}/${TEST_REPO}/${TEST_COMMIT}/source.zip`;
  const ix = await pool.query<{ id: string }>(
    `INSERT INTO indexes
       (repo_id, commit_sha, branch, uploader, tool, status, source_blob_key)
     VALUES ($1, $2, 'main', 'ci', 'scip-java', 'ready', $3)
     ON CONFLICT (repo_id, commit_sha, tool) WHERE status NOT IN ('failed', 'reclaiming') DO UPDATE
       SET status = 'ready', source_blob_key = $3 RETURNING id`,
    [repoId, TEST_COMMIT, sourceBlobKey]
  );
  const indexId = ix.rows[0]!.id;

  await pool.query(
    `INSERT INTO symbols
       (index_id, repo_id, commit_sha, scip_symbol, display_name, kind, language,
        file_path, start_line, start_col, end_line, end_col,
        body_start_line, body_start_col, body_end_line, body_end_col)
     VALUES ($1, $2, $3, $4, 'bar', 'method', 'java',
             'src/Foo.java', 6, 4, 6, 18,
             6, 4, 8, 5)
     ON CONFLICT DO NOTHING`,
    [indexId, repoId, TEST_COMMIT, TEST_SYMBOL]
  );

  // Fallback test용: body_*_line NULL, start_line=5
  await pool.query(
    `INSERT INTO symbols
       (index_id, repo_id, commit_sha, scip_symbol, display_name, kind, language,
        file_path, start_line, start_col, end_line, end_col)
     VALUES ($1, $2, $3, $4, 'x', 'field', 'java',
             'src/Foo.java', 5, 16, 5, 17)
     ON CONFLICT DO NOTHING`,
    [indexId, repoId, TEST_COMMIT, FALLBACK_SYMBOL]
  );

  // Boundary test용: body_*_line NULL, start_line=3 (파일 앞쪽)
  await pool.query(
    `INSERT INTO symbols
       (index_id, repo_id, commit_sha, scip_symbol, display_name, kind, language,
        file_path, start_line, start_col, end_line, end_col)
     VALUES ($1, $2, $3, $4, 'Foo', 'class', 'java',
             'src/Foo.java', 3, 13, 3, 16)
     ON CONFLICT DO NOTHING`,
    [indexId, repoId, TEST_COMMIT, BOUNDARY_SYMBOL]
  );

  // NEWER_COMMIT index (feature branch) — newer created_at for commit-omission tests
  const ixNewer = await pool.query<{ id: string }>(
    `INSERT INTO indexes
       (repo_id, commit_sha, branch, uploader, tool, status, source_blob_key)
     VALUES ($1, $2, 'feature', 'ci', 'scip-java', 'ready', $3)
     ON CONFLICT (repo_id, commit_sha, tool) WHERE status NOT IN ('failed', 'reclaiming') DO UPDATE
       SET status = 'ready', source_blob_key = $3 RETURNING id`,
    [repoId, NEWER_COMMIT, sourceBlobKey]
  );
  const newerIndexId = ixNewer.rows[0]!.id;

  // Same symbol in NEWER_COMMIT for /sources/symbol commit-omission test
  await pool.query(
    `INSERT INTO symbols
       (index_id, repo_id, commit_sha, scip_symbol, display_name, kind, language,
        file_path, start_line, start_col, end_line, end_col,
        body_start_line, body_start_col, body_end_line, body_end_col)
     VALUES ($1, $2, $3, $4, 'bar', 'method', 'java',
             'src/Foo.java', 6, 4, 6, 18,
             6, 4, 8, 5)
     ON CONFLICT DO NOTHING`,
    [newerIndexId, repoId, NEWER_COMMIT, TEST_SYMBOL]
  );

  // repo_head: main → TEST_COMMIT (default_branch), feature → NEWER_COMMIT
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
    [repoId, NEWER_COMMIT, newerIndexId]
  );

  // Set up MinIO mock to return our zip
  const { getSourceZipEntry } = await import("../../src/storage/minio.js");
  (getSourceZipEntry as ReturnType<typeof vi.fn>).mockImplementation(
    async (_key: string, filePath: string) => {
      const zip = buildSourceZip(JAVA_CONTENT);
      const AdmZipLib = (await import("adm-zip")).default;
      const z = new AdmZipLib(zip);
      const entry = z.getEntry(filePath);
      if (!entry) return null;
      return z.readFile(entry);
    }
  );

  app = await buildApp(sourcesRoutes);
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

describe("GET /v1/sources/file", () => {
  it("returns source lines for a valid request", async () => {
    if (!available) {
      console.warn("Skipping — Postgres not available");
      return;
    }

    const res = await app.inject({
      method: "GET",
      url: `/v1/sources/file?repo=${TEST_ORG}/${TEST_REPO}&commit=${TEST_COMMIT}&file_path=src/Foo.java&start_line=1&end_line=3`,
    });

    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body) as {
      repo: string; commit_sha: string; file_path: string;
      start_line: number; end_line: number; content: string;
    };
    expect(json.repo).toBe(`${TEST_ORG}/${TEST_REPO}`);
    expect(json.file_path).toBe("src/Foo.java");
    expect(json.start_line).toBe(1);
    expect(json.end_line).toBe(3);
    expect(json.content).toContain("package com.example");
  });

  it("returns 400 when repo is missing", async () => {
    if (!available) return;
    const res = await app.inject({
      method: "GET",
      url: `/v1/sources/file?commit=${TEST_COMMIT}&file_path=src/Foo.java&start_line=1&end_line=3`,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("missing_repo");
  });

  it("returns 404 when file is not in source archive", async () => {
    if (!available) return;
    const res = await app.inject({
      method: "GET",
      url: `/v1/sources/file?repo=${TEST_ORG}/${TEST_REPO}&commit=${TEST_COMMIT}&file_path=src/Missing.java&start_line=1&end_line=5`,
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe("file_not_found_in_source");
  });

  it("returns 404 when index has no source blob (client-only index)", async () => {
    if (!available) return;

    // Insert a client-only index with no source_blob_key
    const r = await pool.query<{ id: string }>(
      "SELECT id FROM repos WHERE org = $1 AND name = $2",
      [TEST_ORG, TEST_REPO]
    );
    const repoId = r.rows[0]!.id;
    const clientCommit = "ccccdddd1234567890abcdef1234567890abcdef";
    await pool.query(
      `INSERT INTO indexes (repo_id, commit_sha, branch, uploader, tool, status)
       VALUES ($1, $2, 'main', 'client', 'scip-java', 'ready')
       ON CONFLICT (repo_id, commit_sha, tool) WHERE status NOT IN ('failed', 'reclaiming') DO UPDATE SET status = 'ready'`,
      [repoId, clientCommit]
    );

    const res = await app.inject({
      method: "GET",
      url: `/v1/sources/file?repo=${TEST_ORG}/${TEST_REPO}&commit=${clientCommit}&file_path=src/Foo.java&start_line=1&end_line=3`,
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe("source_not_available");
  });
});

describe("GET /v1/sources/symbol", () => {
  it("returns symbol body for a known symbol", async () => {
    if (!available) {
      console.warn("Skipping — Postgres not available");
      return;
    }

    const res = await app.inject({
      method: "GET",
      url: `/v1/sources/symbol?scip_symbol=${encodeURIComponent(TEST_SYMBOL)}&repo=${TEST_ORG}/${TEST_REPO}&commit=${TEST_COMMIT}`,
    });

    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body) as {
      scip_symbol: string; file_path: string; content: string; body_source: string;
    };
    expect(json.scip_symbol).toBe(TEST_SYMBOL);
    expect(json.file_path).toBe("src/Foo.java");
    expect(json.body_source).toBe("enclosing_range");
    expect(json.content).toContain("public void bar()");
  });

  it("returns 400 when scip_symbol is missing", async () => {
    if (!available) return;
    const res = await app.inject({
      method: "GET",
      url: `/v1/sources/symbol?repo=${TEST_ORG}/${TEST_REPO}`,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("missing_scip_symbol");
  });

  it("returns 404 for unknown symbol", async () => {
    if (!available) return;
    const res = await app.inject({
      method: "GET",
      url: `/v1/sources/symbol?scip_symbol=scip-unknown%20sym%20does%20not%20exist&repo=${TEST_ORG}/${TEST_REPO}`,
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe("symbol_not_found");
  });

  it("returns ±10 line range when body span is missing (identifier_fallback)", async () => {
    if (!available) return;

    const res = await app.inject({
      method: "GET",
      url: `/v1/sources/symbol?scip_symbol=${encodeURIComponent(FALLBACK_SYMBOL)}&repo=${TEST_ORG}/${TEST_REPO}&commit=${TEST_COMMIT}`,
    });

    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body) as {
      start_line: number; end_line: number; content: string; body_source: string;
    };
    expect(json.body_source).toBe("identifier_fallback");
    // JAVA_CONTENT는 10줄. start_line=5 → max(1, 5-10)=1, min(10, 5+10)=10
    expect(json.start_line).toBe(1);
    expect(json.end_line).toBe(10);
    expect(json.content).toContain("package com.example");
    expect(json.content.split("\n").length).toBe(10);
  });

  it("caps to file boundaries when symbol is near start of file", async () => {
    if (!available) return;

    const res = await app.inject({
      method: "GET",
      url: `/v1/sources/symbol?scip_symbol=${encodeURIComponent(BOUNDARY_SYMBOL)}&repo=${TEST_ORG}/${TEST_REPO}&commit=${TEST_COMMIT}`,
    });

    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body) as {
      start_line: number; end_line: number; body_source: string;
    };
    expect(json.body_source).toBe("identifier_fallback");
    // start_line=3 → max(1, 3-10)=1 (하한 cap), min(10, 3+10)=10 (상한 cap)
    expect(json.start_line).toBe(1);
    expect(json.end_line).toBe(10);
  });
});

describe("commit omission semantics", () => {
  it("uses repo_head(default_branch) when commit is omitted for /v1/sources/file", async () => {
    if (!available) return;
    // NEWER_COMMIT is on 'feature' branch; repo_head(main) points to TEST_COMMIT.
    // Omitting commit should resolve to TEST_COMMIT, not NEWER_COMMIT.
    const res = await app.inject({
      method: "GET",
      url: `/v1/sources/file?repo=${TEST_ORG}/${TEST_REPO}&file_path=src/Foo.java&start_line=1&end_line=3`,
    });
    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body) as { commit_sha: string };
    expect(json.commit_sha).toBe(TEST_COMMIT);
  });

  it("uses repo_head(default_branch) for /v1/sources/symbol when commit is omitted", async () => {
    if (!available) return;
    // NEWER_COMMIT has TEST_SYMBOL too, and its created_at is later.
    // Current impl uses ORDER BY created_at DESC → returns NEWER_COMMIT. Should be TEST_COMMIT.
    const res = await app.inject({
      method: "GET",
      url: `/v1/sources/symbol?scip_symbol=${encodeURIComponent(TEST_SYMBOL)}&repo=${TEST_ORG}/${TEST_REPO}`,
    });
    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body) as { commit_sha: string };
    expect(json.commit_sha).toBe(TEST_COMMIT);
  });

  it("returns 404 when repo_head.index_id is NULL", async () => {
    if (!available) return;
    // Null out main branch index_id, run assertion, restore
    await pool.query(
      `UPDATE repo_head SET index_id = NULL
       WHERE repo_id = (SELECT id FROM repos WHERE org = $1 AND name = $2)
       AND branch = 'main'`,
      [TEST_ORG, TEST_REPO]
    );
    try {
      const res = await app.inject({
        method: "GET",
        url: `/v1/sources/file?repo=${TEST_ORG}/${TEST_REPO}&file_path=src/Foo.java&start_line=1&end_line=3`,
      });
      expect(res.statusCode).toBe(404);
      expect((JSON.parse(res.body) as { error: string }).error).toBe("index_not_found");
    } finally {
      // Restore main → TEST_COMMIT index
      await pool.query(
        `UPDATE repo_head SET index_id = (
           SELECT i.id FROM indexes i
           JOIN repos r ON r.id = i.repo_id
           WHERE r.org = $1 AND r.name = $2 AND i.commit_sha = $3 AND i.status = 'ready'
           LIMIT 1
         )
         WHERE repo_id = (SELECT id FROM repos WHERE org = $1 AND name = $2)
         AND branch = 'main'`,
        [TEST_ORG, TEST_REPO, TEST_COMMIT]
      );
    }
  });

  it("returns 404 index_not_found with default branch in detail when repo_head has no row", async () => {
    if (!available) return;
    // Use a repo with no repo_head entry
    const noHeadOrg = "test-sources-no-head";
    const noHeadRepo = "app";
    const noHeadCommit = "aaaa00001111222233334444555566667777888a";
    const r2 = await pool.query<{ id: string }>(
      `INSERT INTO repos (org, name) VALUES ($1, $2)
       ON CONFLICT (org, name) DO UPDATE SET updated_at = NOW() RETURNING id`,
      [noHeadOrg, noHeadRepo]
    );
    const r2Id = r2.rows[0]!.id;
    await pool.query(
      `INSERT INTO indexes (repo_id, commit_sha, branch, uploader, tool, status)
       VALUES ($1, $2, 'main', 'ci', 'scip-java', 'ready')
       ON CONFLICT (repo_id, commit_sha, tool) WHERE status NOT IN ('failed', 'reclaiming') DO UPDATE SET status='ready'`,
      [r2Id, noHeadCommit]
    );
    // repo_head row intentionally absent — resolveCommit should return 404

    const res = await app.inject({
      method: "GET",
      url: `/v1/sources/file?repo=${noHeadOrg}/${noHeadRepo}&file_path=src/Foo.java&start_line=1&end_line=3`,
    });
    expect(res.statusCode).toBe(404);
    const json = JSON.parse(res.body) as { error: string; detail?: string };
    expect(json.error).toBe("index_not_found");
    expect(json.detail).toBeDefined();
    expect(json.detail!).toContain("'main'");

    await pool.query("DELETE FROM repos WHERE org = $1 AND name = $2", [noHeadOrg, noHeadRepo]);
  });
});

describe("branch param", () => {
  it("GET /v1/sources/file resolves commit from branch param", async () => {
    if (!available) { console.warn("Skipping — Postgres not available"); return; }
    const mockFileBuffer = Buffer.from(JAVA_CONTENT, "utf8");
    vi.mocked(getSourceZipEntry).mockResolvedValueOnce(mockFileBuffer);

    const url =
      `/v1/sources/file?repo=${TEST_ORG}/${TEST_REPO}` +
      `&file_path=${encodeURIComponent("src/Foo.java")}` +
      `&start_line=1&end_line=3` +
      `&branch=feature`;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ commit_sha: string }>().commit_sha).toBe(NEWER_COMMIT);
  });

  it("GET /v1/sources/symbol resolves commit from branch param", async () => {
    if (!available) { console.warn("Skipping — Postgres not available"); return; }
    const mockFileBuffer = Buffer.from(JAVA_CONTENT, "utf8");
    vi.mocked(getSourceZipEntry).mockResolvedValueOnce(mockFileBuffer);

    const url =
      `/v1/sources/symbol?repo=${TEST_ORG}/${TEST_REPO}` +
      `&scip_symbol=${encodeURIComponent(TEST_SYMBOL)}` +
      `&branch=feature`;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ commit_sha: string }>().commit_sha).toBe(NEWER_COMMIT);
  });
});
