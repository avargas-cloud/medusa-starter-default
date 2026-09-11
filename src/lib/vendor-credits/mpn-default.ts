import type { PgClient, VendorCreditLineInput } from "./types";

/**
 * Product lines that don't send an `mpn` default it from
 * `product_variant.metadata->>'mpn'` — the same source and the same
 * `typeof === "string"` guard `receipts/[receiptId]/vendor-bill/route.ts`
 * uses to resolve `vendor_bill_line.mpn` (never invent one, never coerce a
 * non-string metadata value).
 *
 * Returns a NEW array (immutable) — one query for however many distinct
 * variant ids need a lookup, never one per line.
 */
export async function resolveMpnDefaults(
  client: PgClient,
  lines: VendorCreditLineInput[]
): Promise<VendorCreditLineInput[]> {
  const variantIdsNeedingLookup = [
    ...new Set(
      lines
        .filter((l) => l.line_type === "product" && !l.mpn && l.variant_id)
        .map((l) => l.variant_id as string)
    ),
  ];
  if (variantIdsNeedingLookup.length === 0) return lines;

  const { rows } = await client.query(
    `SELECT id, metadata FROM product_variant WHERE id = ANY($1::text[]) AND deleted_at IS NULL`,
    [variantIdsNeedingLookup]
  );
  const mpnByVariantId = new Map<string, string | null>(
    (rows as { id: string; metadata: Record<string, unknown> | null }[]).map((r) => [
      r.id,
      typeof r.metadata?.mpn === "string" ? r.metadata.mpn : null,
    ])
  );

  return lines.map((line) =>
    line.line_type === "product" && !line.mpn && line.variant_id
      ? { ...line, mpn: mpnByVariantId.get(line.variant_id) ?? null }
      : line
  );
}
