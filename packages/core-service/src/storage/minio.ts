import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { config } from "../config.js";

let client: S3Client | null = null;

export function getS3Client(): S3Client {
  if (!client) {
    client = new S3Client({
      endpoint: `http${config.MINIO_USE_SSL ? "s" : ""}://${config.MINIO_ENDPOINT}:${config.MINIO_PORT}`,
      region: "us-east-1",
      credentials: {
        accessKeyId: config.MINIO_ROOT_USER,
        secretAccessKey: config.MINIO_ROOT_PASSWORD,
      },
      forcePathStyle: true,
    });
  }
  return client;
}

export async function ensureBucket(): Promise<void> {
  const s3 = getS3Client();
  try {
    await s3.send(new HeadBucketCommand({ Bucket: config.MINIO_BUCKET }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: config.MINIO_BUCKET }));
  }
}

export async function putScipBlob(key: string, data: Buffer): Promise<void> {
  await getS3Client().send(
    new PutObjectCommand({
      Bucket: config.MINIO_BUCKET,
      Key: key,
      Body: data,
      ContentType: "application/octet-stream",
    })
  );
}

export async function getScipBlob(key: string): Promise<Buffer> {
  const resp = await getS3Client().send(
    new GetObjectCommand({ Bucket: config.MINIO_BUCKET, Key: key })
  );
  if (!resp.Body) throw new Error(`Empty body for key: ${key}`);
  const stream = resp.Body as Readable;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

export async function checkMinioHealth(): Promise<boolean> {
  try {
    await getS3Client().send(new HeadBucketCommand({ Bucket: config.MINIO_BUCKET }));
    return true;
  } catch {
    return false;
  }
}
