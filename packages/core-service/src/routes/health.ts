import type { FastifyInstance } from "fastify";
import { checkDbHealth } from "../storage/postgres.js";
import { checkMinioHealth } from "../storage/minio.js";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/healthz", async (_req, reply) => {
    const [db, minio] = await Promise.all([checkDbHealth(), checkMinioHealth()]);
    const status = db && minio ? "ok" : "degraded";
    return reply
      .status(status === "ok" ? 200 : 503)
      .send({ status, db: db ? "up" : "down", minio: minio ? "up" : "down" });
  });
}
