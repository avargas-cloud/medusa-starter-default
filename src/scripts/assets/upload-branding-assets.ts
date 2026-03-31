/**
 * Upload branding assets to MinIO.
 *
 * Usage:
 *   npx ts-node src/scripts/assets/upload-branding-assets.ts
 *
 * Uploads:
 *   backend/static/images/logo.png  →  branding/logo.png
 */

import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3"
import * as fs from "fs"
import * as path from "path"

interface UploadResult {
  key: string
  url: string
  alreadyExisted: boolean
}

function buildS3Client(): S3Client {
  const endpoint = process.env.MINIO_ENDPOINT
  const accessKeyId = process.env.MINIO_ACCESS_KEY
  const secretAccessKey = process.env.MINIO_SECRET_KEY

  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "Missing required env vars: MINIO_ENDPOINT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY"
    )
  }

  return new S3Client({
    endpoint,
    region: "us-east-1",
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  })
}

async function objectExists(client: S3Client, bucket: string, key: string): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    return true
  } catch {
    return false
  }
}

async function uploadFile(
  client: S3Client,
  bucket: string,
  key: string,
  filePath: string,
  contentType: string,
  force = false
): Promise<UploadResult> {
  const baseUrl = process.env.MINIO_ENDPOINT!
  const url = `${baseUrl}/${bucket}/${key}`

  const alreadyExisted = await objectExists(client, bucket, key)
  if (alreadyExisted && !force) {
    console.log(`  ⏭  Already exists: ${key}`)
    return { key, url, alreadyExisted: true }
  }

  const body = fs.readFileSync(filePath)
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      // Public read — branding assets are always public
      ACL: "public-read",
      // Long cache: 1 year (update key if logo changes)
      CacheControl: "public, max-age=31536000, immutable",
    })
  )

  console.log(`  ✓  Uploaded: ${key}  →  ${url}`)
  return { key, url, alreadyExisted: false }
}

async function main(): Promise<void> {
  // Load .env manually if not loaded by the runtime
  const dotenvPath = path.resolve(__dirname, "../../../.env")
  if (fs.existsSync(dotenvPath)) {
    const lines = fs.readFileSync(dotenvPath, "utf8").split("\n")
    for (const line of lines) {
      const match = line.match(/^([^#=]+)=(.*)$/)
      if (match) {
        const [, key, value] = match
        if (!process.env[key.trim()]) {
          process.env[key.trim()] = value.trim().replace(/^["']|["']$/g, "")
        }
      }
    }
  }

  const bucket = process.env.MINIO_BUCKET
  if (!bucket) throw new Error("MINIO_BUCKET env var is required")

  const client = buildS3Client()
  const force = process.argv.includes("--force")

  const staticDir = path.resolve(__dirname, "../../../static/images")

  console.log("\nUploading branding assets to MinIO...")
  console.log(`  Bucket : ${bucket}`)
  console.log(`  Force  : ${force}\n`)

  const assets: Array<{ localPath: string; key: string; contentType: string }> = [
    {
      localPath: path.join(staticDir, "logo.png"),
      key: "branding/logo.png",
      contentType: "image/png",
    },
  ]

  const results: UploadResult[] = []
  for (const asset of assets) {
    if (!fs.existsSync(asset.localPath)) {
      console.warn(`  ⚠  File not found, skipping: ${asset.localPath}`)
      continue
    }
    const result = await uploadFile(client, bucket, asset.key, asset.localPath, asset.contentType, force)
    results.push(result)
  }

  console.log("\n--- Results ---")
  for (const r of results) {
    console.log(`  ${r.key}`)
    console.log(`  ${r.url}\n`)
  }

  console.log("Done. Update BRANDING_LOGO_URL in .env if needed:")
  const logoResult = results.find((r) => r.key === "branding/logo.png")
  if (logoResult) {
    console.log(`  BRANDING_LOGO_URL=${logoResult.url}`)
  }
}

main().catch((err) => {
  console.error("Upload failed:", err)
  process.exit(1)
})
