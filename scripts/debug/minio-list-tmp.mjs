import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
const s3 = new S3Client({ endpoint: process.env.MINIO_ENDPOINT, region: "us-east-1",
  credentials: { accessKeyId: process.env.MINIO_ACCESS_KEY, secretAccessKey: process.env.MINIO_SECRET_KEY }, forcePathStyle: true });
const bucket = process.env.MINIO_BUCKET || "medusa-media";
const prefix = process.argv[2] || "";
const delim = process.argv[3] === "nodelim" ? undefined : "/";
console.log("endpoint host:", new URL(process.env.MINIO_ENDPOINT).host, "bucket:", bucket, "prefix:", JSON.stringify(prefix), "delim:", delim);
try {
  const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, Delimiter: delim, MaxKeys: 1000 }));
  console.log("KeyCount:", r.KeyCount, "IsTruncated:", r.IsTruncated);
  console.log("CommonPrefixes:", (r.CommonPrefixes||[]).map(p=>p.Prefix));
  console.log("Contents (first 15):", (r.Contents||[]).slice(0,15).map(c=>c.Key));
} catch (e) { console.error("ERR", e.name, e.message, e.$metadata); }
