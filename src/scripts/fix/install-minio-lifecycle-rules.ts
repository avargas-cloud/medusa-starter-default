/**
 * install-minio-lifecycle-rules.ts
 *
 * Installs the FULL set of MinIO bucket lifecycle rules. Idempotent — safe to
 * re-run. IMPORTANT: PutBucketLifecycleConfiguration REPLACES the bucket's
 * entire lifecycle config, so every rule the bucket should have MUST be
 * declared here. Adding a new rule elsewhere without including these wipes
 * them silently.
 *
 * Current rules:
 *  - pdf-shares-30d-expiry:       pdf-shares/       → 30 days (shared doc PDFs)
 *  - shipping-labels-30d-expiry:  shipping-labels/  → 30 days (bought labels;
 *    operational at dispatch time only — order_delivery keeps carrier
 *    tracking_url + provider_label_url for diagnostics after expiry)
 *
 * Run: env $(grep -E '^MINIO_' .env | xargs) ./node_modules/.bin/tsx src/scripts/fix/install-minio-lifecycle-rules.ts
 *   (or via medusa exec with explicit env — see CLAUDE.md)
 */

import {
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const RULES = [
  {
    ID: "pdf-shares-30d-expiry",
    Status: "Enabled" as const,
    Filter: { Prefix: "pdf-shares/" },
    Expiration: { Days: 30 },
  },
  {
    ID: "shipping-labels-30d-expiry",
    Status: "Enabled" as const,
    Filter: { Prefix: "shipping-labels/" },
    Expiration: { Days: 30 },
  },
];

async function main() {
  const endpoint = process.env.MINIO_ENDPOINT;
  const accessKeyId = process.env.MINIO_ACCESS_KEY;
  const secretAccessKey = process.env.MINIO_SECRET_KEY;
  const bucket = process.env.MINIO_BUCKET;

  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error(
      "Missing MINIO_ENDPOINT / MINIO_ACCESS_KEY / MINIO_SECRET_KEY / MINIO_BUCKET env vars"
    );
  }

  const client = new S3Client({
    endpoint,
    region: "us-east-1",
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });

  console.log(`Bucket: ${bucket} @ ${endpoint}`);

  try {
    const before = await client.send(
      new GetBucketLifecycleConfigurationCommand({ Bucket: bucket })
    );
    console.log(
      "Rules BEFORE:",
      (before.Rules ?? []).map((r) => r.ID).join(", ") || "(none)"
    );
  } catch {
    console.log("Rules BEFORE: (none)");
  }

  await client.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: bucket,
      LifecycleConfiguration: { Rules: RULES },
    })
  );

  const after = await client.send(
    new GetBucketLifecycleConfigurationCommand({ Bucket: bucket })
  );
  console.log("Rules AFTER:");
  for (const r of after.Rules ?? []) {
    console.log(
      `  - ${r.ID}: prefix=${r.Filter?.Prefix} days=${r.Expiration?.Days} status=${r.Status}`
    );
  }
  console.log("✓ done");
}

main().catch((err) => {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
