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
const TEST_SYMBOL = "scip-java maven com.example:srcapp 1.0 com/example/Foo#bar().";
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
     ON CONFLICT (repo_id, commit_sha, tool) DO UPDATE
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
       ON CONFLICT (repo_id, commit_sha, tool) DO UPDATE SET status = 'ready'`,
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
});
