import { DateRange } from "./date-range"

export type Bucket = "day" | "month"

export function autoBucket(range: DateRange): Bucket {
  const diffDays =
    (new Date(range.to).getTime() - new Date(range.from).getTime()) /
    86_400_000
  return diffDays < 60 ? "day" : "month"
}

export function bucketTrunc(bucket: Bucket, col: string): string {
  return `DATE_TRUNC('${bucket}', ${col})`
}

export function formatBucketLabel(bucket: Bucket, date: Date): string {
  if (bucket === "day") return date.toISOString().slice(0, 10)
  return date.toISOString().slice(0, 7)
}
