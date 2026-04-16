import type { FastifyRequest, FastifyReply } from "fastify";
import { config } from "../config.js";

export type Uploader = "ci" | "client";

export function parseUploader(raw: unknown): Uploader | null {
  if (raw === "ci" || raw === "client") return raw;
  return null;
}

export async function verifyBearer(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers["authorization"];
  if (!authHeader?.startsWith("Bearer ")) {
    return reply.status(401).send({ error: "missing_token" });
  }
  const token = authHeader.slice(7);

  const uploaderHeader = request.headers["x-cms-uploader"];
  const uploader = parseUploader(uploaderHeader);

  if (!uploader) {
    return reply.status(400).send({ error: "invalid_uploader", detail: "X-CMS-Uploader must be 'ci' or 'client'" });
  }

  const expected = uploader === "ci" ? config.CMS_CI_TOKEN : config.CMS_CLIENT_TOKEN;
  if (token !== expected) {
    return reply.status(403).send({ error: "invalid_token" });
  }

  (request as FastifyRequest & { uploader: Uploader }).uploader = uploader;
}
