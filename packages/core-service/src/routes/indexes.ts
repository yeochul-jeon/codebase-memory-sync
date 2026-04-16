import type { FastifyInstance } from "fastify";
import { getPool } from "../storage/postgres.js";

export async function indexesRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>(
    "/v1/indexes/:id",
    async (request, reply) => {
      const { id } = request.params;
      const res = await getPool().query<{
        id: string;
        repo_id: string;
        commit_sha: string;
        uploader: string;
        tool: string;
        status: string;
        error_msg: string | null;
        created_at: string;
        updated_at: string;
      }>(
        `SELECT id, repo_id, commit_sha, uploader, tool, status, error_msg, created_at, updated_at
         FROM indexes WHERE id = $1`,
        [id]
      );

      if (res.rows.length === 0) {
        return reply.status(404).send({ error: "not_found" });
      }

      return reply.send(res.rows[0]);
    }
  );
}
