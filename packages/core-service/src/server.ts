import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { config } from "./config.js";
import { runMigrations, closePool } from "./storage/postgres.js";
import { ensureBucket } from "./storage/minio.js";
import { healthRoutes } from "./routes/health.js";
import { uploadRoutes } from "./routes/upload.js";
import { reposRoutes } from "./routes/repos.js";
import { indexesRoutes } from "./routes/indexes.js";
import { searchRoutes } from "./routes/search.js";

const app = Fastify({
  logger: {
    level: config.LOG_LEVEL,
    ...(process.env["NODE_ENV"] !== "production"
      ? { transport: { target: "pino-pretty", options: { colorize: true } } }
      : {}),
  },
});

// Plugins
await app.register(multipart, {
  limits: {
    fileSize: config.MAX_SCIP_SIZE_MB * 1024 * 1024,
    files: 1,
  },
});

// Routes
await app.register(healthRoutes);
await app.register(uploadRoutes);
await app.register(reposRoutes);
await app.register(indexesRoutes);
await app.register(searchRoutes);

// Graceful shutdown
const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  await closePool();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// Bootstrap
try {
  app.log.info("Running DB migrations...");
  await runMigrations();
  app.log.info("Ensuring MinIO bucket...");
  await ensureBucket();
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
  app.log.info(`Server listening on port ${config.PORT}`);
} catch (err) {
  app.log.error(err, "Failed to start server");
  process.exit(1);
}
