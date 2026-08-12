/**
 * src/api/admin/pos/price-batches/_lib/validate-draft-rows.ts
 *
 * LAX shape validation for draft rows — a draft is work-in-progress, so
 * unlike `validateBulkRows` (used at submit) this does NOT enforce "at
 * least one field set", wholesale<=retail pairing, or drop no-op rows. It
 * only guards the shape so a malformed autosave can't corrupt the table:
 * ids are non-empty strings, numeric fields (when present) are finite and
 * >= 0, and the row count is capped like the bulk editor.
 *
 * `sku`/`description` here are a client-supplied DISPLAY SNAPSHOT (the
 * autosave body), unlike the live lookup submit does via
 * `loadLiveVariantSnapshots` — keeps the autosave endpoint from needing a DB
 * round trip on every debounced keystroke.
 */
import { MAX_BULK_ROWS } from "../../prices/bulk/_lib/validate-bulk-rows";

export interface DraftRow {
  variant_id: string;
  product_id: string;
  sku: string | null;
  description: string | null;
  cost?: number;
  retail_price?: number;
  wholesale_price?: number;
}

export interface DraftRowError {
  index: number;
  variant_id: unknown;
  message: string;
}

const isFiniteNonNegative = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * `rows` may be absent, null, or an empty array — a draft can exist with
 * nothing in it yet.
 */
export function validateDraftRows(body: unknown): {
  rows: DraftRow[] | null;
  errors: DraftRowError[];
  tooMany: boolean;
} {
  const rawRows = (body as { rows?: unknown })?.rows;

  if (rawRows === undefined || rawRows === null) {
    return { rows: [], errors: [], tooMany: false };
  }
  if (!Array.isArray(rawRows)) {
    return {
      rows: null,
      errors: [{ index: -1, variant_id: null, message: "rows must be an array" }],
      tooMany: false,
    };
  }
  if (rawRows.length > MAX_BULK_ROWS) {
    return { rows: null, errors: [], tooMany: true };
  }

  const errors: DraftRowError[] = [];
  const rows: DraftRow[] = [];

  rawRows.forEach((raw, index) => {
    const row = raw as Partial<DraftRow> | null | undefined;
    const variant_id = row?.variant_id;
    const push = (message: string) =>
      errors.push({ index, variant_id: variant_id ?? null, message });

    const validVariantId =
      typeof row?.variant_id === "string" && row.variant_id.trim() !== "";
    const validProductId =
      typeof row?.product_id === "string" && row.product_id.trim() !== "";

    if (!validVariantId) push("variant_id must be a non-empty string");
    if (!validProductId) push("product_id must be a non-empty string");

    if (row?.sku !== undefined && row.sku !== null && typeof row.sku !== "string") {
      push("sku must be a string");
    }
    if (
      row?.description !== undefined &&
      row.description !== null &&
      typeof row.description !== "string"
    ) {
      push("description must be a string");
    }
    if (row?.cost !== undefined && !isFiniteNonNegative(row.cost)) {
      push("cost must be a finite number >= 0");
    }
    if (row?.retail_price !== undefined && !isFiniteNonNegative(row.retail_price)) {
      push("retail_price must be a finite number >= 0");
    }
    if (row?.wholesale_price !== undefined && !isFiniteNonNegative(row.wholesale_price)) {
      push("wholesale_price must be a finite number >= 0");
    }

    if (validVariantId && validProductId) {
      rows.push({
        variant_id: row!.variant_id as string,
        product_id: row!.product_id as string,
        sku: typeof row?.sku === "string" ? row.sku : null,
        description: typeof row?.description === "string" ? row.description : null,
        cost: row?.cost,
        retail_price: row?.retail_price,
        wholesale_price: row?.wholesale_price,
      });
    }
  });

  if (errors.length > 0) {
    return { rows: null, errors, tooMany: false };
  }
  return { rows, errors: [], tooMany: false };
}
