import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import type { TreasuryBucketView } from "../daily/types";
import type { TreasuryBucketCode } from "../_lib/compute-splits";

interface BucketRow {
  id: string;
  code: TreasuryBucketCode;
  label: string;
  display_order: number;
  is_active: boolean;
  source_bank_id: string | null;
  source_bank_name: string | null;
  source_bank_type: string | null;
  dest_bank_id: string | null;
  dest_bank_name: string | null;
  dest_bank_type: string | null;
}

/**
 * GET /admin/accounting/treasury/buckets
 *
 * Lists the 5 treasury buckets with their current source and destination
 * bank mappings. Returned in display_order for stable UI rendering.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pg = req.scope.resolve("__pg_connection__") as any;

  try {
    const result = await pg.raw(
      `SELECT
         tb.id, tb.code, tb.label, tb.display_order, tb.is_active,
         src.id AS source_bank_id, src.name AS source_bank_name, src.type AS source_bank_type,
         dst.id AS dest_bank_id,   dst.name AS dest_bank_name,   dst.type AS dest_bank_type
       FROM treasury_bucket tb
       LEFT JOIN qb_bank_account src
         ON src.id = tb.source_qb_bank_account_id AND src.deleted_at IS NULL
       LEFT JOIN qb_bank_account dst
         ON dst.id = tb.qb_bank_account_id AND dst.deleted_at IS NULL
       ORDER BY tb.display_order, tb.code`
    );

    const rows: BucketRow[] = result.rows ?? [];
    const buckets: TreasuryBucketView[] = rows.map((row) => ({
      id: row.id,
      code: row.code,
      label: row.label,
      display_order: row.display_order,
      is_active: row.is_active,
      source_bank: row.source_bank_id
        ? {
            id: row.source_bank_id,
            name: row.source_bank_name ?? "",
            type: row.source_bank_type ?? "",
          }
        : null,
      destination_bank: row.dest_bank_id
        ? {
            id: row.dest_bank_id,
            name: row.dest_bank_name ?? "",
            type: row.dest_bank_type ?? "",
          }
        : null,
    }));

    return res.json({ success: true, data: { buckets } });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to load treasury buckets";
    return res.status(500).json({ success: false, error: message });
  }
}
