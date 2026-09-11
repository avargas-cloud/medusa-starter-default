import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
const s3 = new S3Client({ endpoint: process.env.MINIO_ENDPOINT, region: "us-east-1",
  credentials: { accessKeyId: process.env.MINIO_ACCESS_KEY, secretAccessKey: process.env.MINIO_SECRET_KEY }, forcePathStyle: true });
const bucket = process.env.MINIO_BUCKET || "medusa-media";
const prefix = process.argv[2] || "";
const q = (process.argv[3] || "").toLowerCase();
let tok, n = 0, pages = 0, hits = [], sub = new Set();
const t0 = Date.now();
do {
  const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, Delimiter: "/", MaxKeys: 1000, ContinuationToken: tok }));
  pages++; n += (r.Contents||[]).length;
  for (const p of r.CommonPrefixes||[]) sub.add(p.Prefix);
  if (q) for (const c of r.Contents||[]) if (c.Key.toLowerCase().includes(q)) hits.push(c.Key);
  tok = r.NextContinuationToken;
} while (tok);
console.log({ prefix, files: n, pages, subfolders: [...sub].length, ms: Date.now()-t0, hits: hits.slice(0,10), hitCount: hits.length });
