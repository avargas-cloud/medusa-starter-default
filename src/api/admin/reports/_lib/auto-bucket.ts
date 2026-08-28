import { DateRange } from "./date-range"

export type Bucket = "day" | "month"

/**
 * Width of the range decides the bucket — unless the caller asks for one.
 *
 * The override exists for reports whose SHAPE is fixed regardless of how much
 * time the window covers: an annual chart draws one bar per month, and a "This
 * Year" range in early January is under 60 days, so auto-bucketing would hand
 * it days and the chart would be wrong at exactly one time of year. An unknown
 * or absent value falls back to auto, so a stray query param can't produce a
 * bucket the SQL doesn't understand.
 */
export function parseBucket(value: unknown): Bucket | undefined {
  return value === "day" || value === "month" ? value : undefined
}

export function autoBucket(range: DateRange, override?: Bucket): Bucket {
  if (override) return override
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

/**
 * SQL that renders the bucket as its calendar label ("2026-08-01" / "2026-08").
 *
 * Formatting in SQL rather than in JS is not a style choice. `DATE_TRUNC` comes
 * back through node-postgres as a JS `Date`, so `String(row.bucket).slice(0,7)`
 * — which is what this endpoint did — yields "Sat Aug", not "2026-08": the
 * label carried the weekday and lost the year. It looked plausible enough on a
 * chart axis to survive unnoticed, and it breaks outright the moment anything
 * tries to PARSE the label back into a month.
 */
export function bucketLabel(bucket: Bucket, col: string): string {
  const mask = bucket === "day" ? "YYYY-MM-DD" : "YYYY-MM"
  return `TO_CHAR(${bucketTrunc(bucket, col)}, '${mask}')`
}
