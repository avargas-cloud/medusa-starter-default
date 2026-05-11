import { MedusaRequest } from "@medusajs/framework/http"

export interface DateRange {
  from: string
  to: string
}

export function parseDateRange(req: MedusaRequest): DateRange | null {
  const { from, to } = req.query as { from?: string; to?: string }
  if (!from || !to) return null
  const f = new Date(from)
  const t = new Date(to)
  if (isNaN(f.getTime()) || isNaN(t.getTime())) return null
  return { from, to }
}

export function priorPeriod(range: DateRange): DateRange {
  const from = new Date(range.from)
  const to = new Date(range.to)
  const diff = to.getTime() - from.getTime()
  return {
    from: new Date(from.getTime() - diff).toISOString(),
    to: new Date(to.getTime() - diff).toISOString(),
  }
}
