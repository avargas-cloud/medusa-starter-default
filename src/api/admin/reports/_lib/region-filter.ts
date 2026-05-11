import { MedusaRequest } from "@medusajs/framework/http"

export type Region = 'all' | 'usa' | 'china'

export function parseRegion(req: MedusaRequest): Region {
  const r = (req.query?.region as string | undefined)?.toLowerCase()
  if (r === 'china') return 'china'
  if (r === 'usa')   return 'usa'
  return 'all'
}

export function regionClause(region: Region): string {
  if (region === 'china') return `AND p.metadata->>'is_sourced_via_agent' = 'true'`
  if (region === 'usa')   return `AND pii.variant_id IS NOT NULL AND (p.metadata->>'is_sourced_via_agent' IS NULL OR p.metadata->>'is_sourced_via_agent' != 'true')`
  return ''
}
