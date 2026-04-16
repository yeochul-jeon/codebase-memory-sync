import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  POSTGRES_HOST: z.string().default("localhost"),
  POSTGRES_PORT: z.coerce.number().default(5432),
  POSTGRES_DB: z.string().default("cms"),
  POSTGRES_USER: z.string().default("cms"),
  POSTGRES_PASSWORD: z.string(),

  MINIO_ENDPOINT: z.string().default("localhost"),
  MINIO_PORT: z.coerce.number().default(9000),
  MINIO_USE_SSL: z.coerce.boolean().default(false),
  MINIO_ROOT_USER: z.string().default("minioadmin"),
  MINIO_ROOT_PASSWORD: z.string(),
  MINIO_BUCKET: z.string().default("cms-scip"),

  CMS_CI_TOKEN: z.string(),
  CMS_CLIENT_TOKEN: z.string(),

  MAX_SCIP_SIZE_MB: z.coerce.number().default(200),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
