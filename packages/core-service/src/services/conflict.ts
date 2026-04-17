import type { PoolClient } from "pg";
import type { Uploader } from "../auth/bearer.js";

export type ConflictDecision =
  | { action: "insert"; replaces?: string }
  | { action: "idempotent"; indexId: string }
  | { action: "ci_wins" };

/**
 * CI-wins conflict resolution rules:
 *   - Same idempotency key → idempotent replay (200)
 *   - CI uploading over existing client index → replace (insert, old row deleted later)
 *   - Client uploading when CI index already exists → ci_wins (409)
 *   - Client over client, CI over CI → replace (CI is authoritative; client self-overwrites allowed)
 */
export async function resolveConflict(
  client: PoolClient,
  opts: {
    repoId: string;
    commitSha: string;
    tool: string;
    uploader: Uploader;
    idempotencyKey: string;
  }
): Promise<ConflictDecision> {
  // Check idempotency key first
  const receiptRes = await client.query<{ index_id: string }>(
    "SELECT index_id FROM upload_receipts WHERE idempotency_key = $1",
    [opts.idempotencyKey]
  );
  if (receiptRes.rows.length > 0 && receiptRes.rows[0]) {
    return { action: "idempotent", indexId: receiptRes.rows[0].index_id };
  }

  // Check for existing index for this (repo, commit, tool)
  const existingRes = await client.query<{ id: string; uploader: string }>(
    "SELECT id, uploader FROM indexes WHERE repo_id = $1 AND commit_sha = $2 AND tool = $3",
    [opts.repoId, opts.commitSha, opts.tool]
  );

  if (existingRes.rows.length === 0) {
    return { action: "insert" };
  }

  const existing = existingRes.rows[0]!;

  // Client trying to overwrite a CI index → reject
  if (opts.uploader === "client" && existing.uploader === "ci") {
    return { action: "ci_wins" };
  }

  // All other cases (CI over client, CI over CI, client over client) → replace.
  // Mark old row as 'reclaiming' so it leaves the partial-unique index window,
  // allowing the new 'uploading' row to be inserted without a UNIQUE conflict.
  // The caller deletes the old row (and its blobs) only after blob PUT succeeds.
  await client.query(
    "UPDATE indexes SET status = 'reclaiming', status_transition_at = NOW() WHERE id = $1",
    [existing.id]
  );
  return { action: "insert", replaces: existing.id };
}
