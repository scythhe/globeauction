import { S3Client } from "@aws-sdk/client-s3";

// R2 speaks the S3 API, so the same client works against real Cloudflare
// R2 in production and a local MinIO stand-in in dev — only the env vars
// change. forcePathStyle is required for MinIO (bucket-in-path, not
// bucket-as-subdomain); R2 also accepts it, so no branching needed.
let client: S3Client | undefined;

export function getS3Client(): S3Client {
  if (!client) {
    const endpoint = process.env.S3_ENDPOINT;
    const accessKeyId = process.env.S3_ACCESS_KEY_ID;
    const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
    if (!endpoint || !accessKeyId || !secretAccessKey) {
      throw new Error("S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY must be set");
    }
    client = new S3Client({
      endpoint,
      region: process.env.S3_REGION ?? "auto",
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    });
  }
  return client;
}

export function getBucket(): string {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) throw new Error("S3_BUCKET must be set");
  return bucket;
}

// The URL stored on vehicle_photos.url and served to the frontend. Kept
// separate from S3_ENDPOINT because the endpoint used to *write* (the
// API talking to MinIO/R2 directly) isn't necessarily the same as the
// public URL used to *read* (a public bucket URL, or a CDN/custom domain
// in front of R2).
export function publicUrlFor(key: string): string {
  const base = process.env.S3_PUBLIC_BASE_URL;
  if (!base) throw new Error("S3_PUBLIC_BASE_URL must be set");
  return `${base.replace(/\/$/, "")}/${key}`;
}

// The inverse of publicUrlFor — vehicle_photos only stores the public URL,
// not the raw key, so deleting the underlying object needs to recover it.
export function keyFromPublicUrl(url: string): string {
  const base = process.env.S3_PUBLIC_BASE_URL;
  if (!base) throw new Error("S3_PUBLIC_BASE_URL must be set");
  const prefix = `${base.replace(/\/$/, "")}/`;
  if (!url.startsWith(prefix)) {
    throw new Error(`URL ${url} does not match configured S3_PUBLIC_BASE_URL`);
  }
  return url.slice(prefix.length);
}
