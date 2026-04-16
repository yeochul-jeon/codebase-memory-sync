import type { FastifyInstance } from "fastify";
import { getPool } from "../storage/postgres.js";

export async function reposRoutes(app: FastifyInstance): Promise<void> {
  // HEAD check used by Serena fallback uploader before deciding to upload
  app.get<{ Params: { org: string; repo: string }; Querystring: { commit?: string } }>(
    "/v1/repos/:org/:repo/heads",
    async (request, reply) => {
      const { org, repo } = request.params;
      const { commit } = request.query;

      const pool = getPool();

      if (commit) {
        // Check if a ready index exists for this specific commit
        const res = await pool.query<{ id: string; commit_sha: string; tool: string; status: string }>(
          `SELECT i.id, i.commit_sha, i.tool, i.status
           FROM indexes i
           JOIN repos r ON r.id = i.repo_id
           WHERE r.org = $1 AND r.name = $2 AND i.commit_sha = $3 AND i.status = 'ready'`,
          [org, repo, commit]
        );
        return reply.send({ indexed: res.rows.length > 0, indexes: res.rows });
      }

      // Return latest ready heads per branch
      const res = await pool.query<{ branch: string; commit_sha: string; indexed_at: string }>(
        `SELECT rh.branch, rh.commit_sha, rh.indexed_at
         FROM repo_head rh
         JOIN repos r ON r.id = rh.repo_id
         WHERE r.org = $1 AND r.name = $2`,
        [org, repo]
      );
      return reply.send({ heads: res.rows });
    }
  );
}
