/**
 * Upload the web landing hero banners to MinIO under redesign/hero/<slug>.jpg.
 *
 * Usage (dry-run by default, prints the plan; APPLY=1 uploads):
 *   env $(grep -E '^MINIO_' .env | xargs) ./node_modules/.bin/tsx src/scripts/assets/upload-hero-banners.ts
 *   env $(grep -E '^MINIO_' .env | xargs) APPLY=1 ./node_modules/.bin/tsx src/scripts/assets/upload-hero-banners.ts
 *
 * Additive only: never deletes, and skips keys that already exist unless FORCE=1.
 * Source dir: _inbox/hero-banners/jpg (gitignored) — override with HERO_SRC; key prefix with HERO_PREFIX (e.g. redesign/tiles).
 */
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import * as fs from "fs";
import * as path from "path";

const SRC = process.env.HERO_SRC || path.resolve(__dirname, "../../../../_inbox/hero-banners/jpg");
const PREFIX = process.env.HERO_PREFIX || "redesign/hero";
const APPLY = process.env.APPLY === "1";
const FORCE = process.env.FORCE === "1";

function client(): S3Client {
  const endpoint = process.env.MINIO_ENDPOINT;
  const accessKeyId = process.env.MINIO_ACCESS_KEY;
  const secretAccessKey = process.env.MINIO_SECRET_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error("Missing MINIO_ENDPOINT / MINIO_ACCESS_KEY / MINIO_SECRET_KEY");
  }
  return new S3Client({ endpoint, region: "us-east-1", credentials: { accessKeyId, secretAccessKey }, forcePathStyle: true });
}

async function exists(s3: S3Client, Bucket: string, Key: string): Promise<boolean> {
  try { await s3.send(new HeadObjectCommand({ Bucket, Key })); return true; } catch { return false; }
}

async function main(): Promise<void> {
  const bucket = process.env.MINIO_BUCKET || "medusa-media";
  const base = `${(process.env.MINIO_ENDPOINT || "").replace(/\/$/, "")}/${bucket}`;
  const files = fs.readdirSync(SRC).filter((f) => f.endsWith(".jpg")).sort();
  if (files.length === 0) throw new Error(`No .jpg files in ${SRC}`);
  const s3 = client();
  let uploaded = 0, skipped = 0;
  for (const f of files) {
    const key = `${PREFIX}/${f}`;
    const already = await exists(s3, bucket, key);
    if (already && !FORCE) { skipped++; console.log(`skip (exists) ${key}`); continue; }
    if (!APPLY) { console.log(`would upload ${key} (${Math.round(fs.statSync(path.join(SRC, f)).size / 1024)} KB)`); continue; }
    await s3.send(new PutObjectCommand({
      Bucket: bucket, Key: key, Body: fs.readFileSync(path.join(SRC, f)),
      ContentType: "image/jpeg", CacheControl: "public, max-age=31536000, immutable",
    }));
    uploaded++;
    console.log(`uploaded ${base}/${key}`);
  }
  console.log(`\n${APPLY ? "uploaded" : "would upload"} ${APPLY ? uploaded : files.length - skipped} · skipped ${skipped} · mode=${APPLY ? "APPLY" : "dry-run"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
