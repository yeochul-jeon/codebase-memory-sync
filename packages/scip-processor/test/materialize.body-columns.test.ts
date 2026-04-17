/**
 * Unit test: materialize() includes body_* columns in symbols INSERT.
 *
 * Uses a mock pg.PoolClient (spy on query) — no Postgres required.
 * Verifies that the INSERT SQL and values include the 4 body span columns
 * added in ADR-014.
 */
import { describe, it, expect, vi } from "vitest";
import { materialize } from "../src/materialize.js";
import type { ParsedIndex } from "../src/parser.js";

function makeMockClient() {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] });
      return { rows: [], rowCount: 0 };
    }),
  };
  return { client, queries };
}

const SYMBOL = "scip-java maven com.example:app 1.0 com/example/OrderService#placeOrder().";

const parsedWithBodySpan: ParsedIndex = {
  symbols: [
    {
      scip_symbol: SYMBOL,
      display_name: "placeOrder",
      kind: "method",
      language: "java",
      file_path: "src/OrderService.java",
      start_line: 10,
      start_col: 2,
      end_line: 10,
      end_col: 22,
      body_start_line: 8,
      body_start_col: 0,
      body_end_line: 20,
      body_end_col: 1,
      signature: null,
      doc: null,
    },
  ],
  occurrences: [],
  relationships: [],
};

describe("materialize — body_* columns (unit)", () => {
  it("includes body_start_line, body_start_col, body_end_line, body_end_col in INSERT column list", async () => {
    const { client, queries } = makeMockClient();

    await materialize(client as never, {
      indexId: "idx-001",
      repoId: "repo-001",
      commitSha: "abc123",
      branch: null,
      parsed: parsedWithBodySpan,
    });

    const insertQuery = queries.find(q =>
      q.sql.includes("INSERT INTO symbols")
    );
    expect(insertQuery).toBeDefined();
    expect(insertQuery!.sql).toContain("body_start_line");
    expect(insertQuery!.sql).toContain("body_start_col");
    expect(insertQuery!.sql).toContain("body_end_line");
    expect(insertQuery!.sql).toContain("body_end_col");
  });

  it("passes correct body span values in INSERT params", async () => {
    const { client, queries } = makeMockClient();

    await materialize(client as never, {
      indexId: "idx-001",
      repoId: "repo-001",
      commitSha: "abc123",
      branch: null,
      parsed: parsedWithBodySpan,
    });

    const insertQuery = queries.find(q =>
      q.sql.includes("INSERT INTO symbols")
    );
    const params = insertQuery!.params as unknown[];
    // body_start_line=8, body_start_col=0, body_end_line=20, body_end_col=1
    expect(params).toContain(8);
    expect(params).toContain(0);
    expect(params).toContain(20);
    expect(params).toContain(1);
  });

  it("body span values are distinct from identifier range values when different", async () => {
    const { client, queries } = makeMockClient();

    await materialize(client as never, {
      indexId: "idx-001",
      repoId: "repo-001",
      commitSha: "abc123",
      branch: null,
      parsed: parsedWithBodySpan,
    });

    const insertQuery = queries.find(q =>
      q.sql.includes("INSERT INTO symbols")
    );
    const params = insertQuery!.params as unknown[];
    // identifier range: start_line=10, end_line=10 (single-line)
    // body range: start_line=8, end_line=20 (multi-line)
    expect(params).toContain(10); // start_line / end_line identifier
    expect(params).toContain(8);  // body_start_line
    expect(params).toContain(20); // body_end_line
  });
});
