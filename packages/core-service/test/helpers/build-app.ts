/**
 * Minimal Fastify app builder for route integration tests.
 * Creates a bare app with only the specified routes registered.
 * No logger, no MinIO, no migrations — just the HTTP layer.
 */
import Fastify, { type FastifyInstance } from "fastify";

export async function buildApp(
  ...plugins: ((app: FastifyInstance) => Promise<void>)[]
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  for (const plugin of plugins) {
    await app.register(plugin);
  }
  return app;
}
