import pg from "pg";
import type { ParsedIndex } from "./parser.js";

const CHUNK_SIZE = 500;

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Bulk-materializes a parsed SCIP index into Postgres.
 *
 * Runs inside a single transaction:
 *   1. DELETE existing symbols/occurrences/relationships for this index
 *   2. BULK INSERT symbols in chunks
 *   3. BULK INSERT occurrences in chunks
 *   4. BULK INSERT symbol_relationships in chunks
 *   5. UPDATE indexes.status = 'ready' + updated_at
 *   6. UPSERT repo_head (latest indexed commit per branch)
 */
export async function materialize(
  client: pg.PoolClient,
  opts: {
    indexId: string;
    repoId: string;
    commitSha: string;
    branch: string | null;
    parsed: ParsedIndex;
  }
): Promise<void> {
  const { indexId, repoId, commitSha, branch, parsed } = opts;

  // 1. Delete any previously materialized data for this index
  await client.query("DELETE FROM symbol_relationships WHERE index_id = $1", [indexId]);
  await client.query("DELETE FROM occurrences WHERE index_id = $1", [indexId]);
  await client.query("DELETE FROM symbols WHERE index_id = $1", [indexId]);

  // 2. Bulk insert symbols
  const symChunks = chunkArray(parsed.symbols, CHUNK_SIZE);
  for (const chunk of symChunks) {
    if (chunk.length === 0) continue;
    const vals: unknown[] = [];
    const ph = chunk.map((s, i) => {
      const base = i * 18;
      vals.push(
        indexId, repoId, commitSha,
        s.scip_symbol, s.display_name, s.kind, s.language, s.file_path,
        s.start_line, s.start_col, s.end_line, s.end_col,
        s.body_start_line, s.body_start_col, s.body_end_line, s.body_end_col,
        s.signature, s.doc
      );
      return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12},$${base + 13},$${base + 14},$${base + 15},$${base + 16},$${base + 17},$${base + 18})`;
    });

    await client.query(
      `INSERT INTO symbols
         (index_id, repo_id, commit_sha, scip_symbol, display_name, kind, language,
          file_path, start_line, start_col, end_line, end_col,
          body_start_line, body_start_col, body_end_line, body_end_col,
          signature, doc)
       VALUES ${ph.join(",")}
       ON CONFLICT DO NOTHING`,
      vals
    );
  }

  // 3. Bulk insert occurrences
  const occChunks = chunkArray(parsed.occurrences, CHUNK_SIZE);
  for (const chunk of occChunks) {
    if (chunk.length === 0) continue;
    const vals: unknown[] = [];
    const ph = chunk.map((o, i) => {
      const base = i * 10;
      vals.push(
        indexId, repoId, commitSha,
        o.scip_symbol, o.file_path,
        o.start_line, o.start_col, o.end_line, o.end_col, o.role
      );
      return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10})`;
    });

    await client.query(
      `INSERT INTO occurrences
         (index_id, repo_id, commit_sha, scip_symbol, file_path,
          start_line, start_col, end_line, end_col, role)
       VALUES ${ph.join(",")}
       ON CONFLICT DO NOTHING`,
      vals
    );
  }

  // 4. Bulk insert relationships
  const relChunks = chunkArray(parsed.relationships, CHUNK_SIZE);
  for (const chunk of relChunks) {
    if (chunk.length === 0) continue;
    const vals: unknown[] = [];
    const ph = chunk.map((rel, i) => {
      const base = i * 9;
      vals.push(
        indexId, repoId, commitSha,
        rel.from_symbol, rel.to_symbol,
        rel.is_reference, rel.is_implementation,
        rel.is_type_definition, rel.is_definition
      );
      return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9})`;
    });
    await client.query(
      `INSERT INTO symbol_relationships
         (index_id, repo_id, commit_sha, from_symbol, to_symbol,
          is_reference, is_implementation, is_type_definition, is_definition)
       VALUES ${ph.join(",")}
       ON CONFLICT DO NOTHING`,
      vals
    );
  }

  // 5. Mark index as ready
  await client.query(
    "UPDATE indexes SET status = 'ready', updated_at = NOW() WHERE id = $1",
    [indexId]
  );

  // 6. Upsert repo_head (only if we have a branch)
  if (branch) {
    await client.query(
      `INSERT INTO repo_head (repo_id, branch, commit_sha, index_id, indexed_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (repo_id, branch) DO UPDATE
         SET commit_sha = EXCLUDED.commit_sha,
             index_id   = EXCLUDED.index_id,
             indexed_at = NOW()`,
      [repoId, branch, commitSha, indexId]
    );
  }
}
