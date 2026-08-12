/**
 * Body-shape validation for the bulk price/cost editor. Runs BEFORE the
 * supervisor PIN guard — same ordering as the single-variant route — so a
 * malformed body never burns a PIN attempt.
 */

export interface BulkPriceRow {
  variant_id: string;
  product_id: string;
  cost?: number;
  retail_price?: number;
  wholesale_price?: number;
}

export interface BulkRowError {
  index: number;
  variant_id: unknown;
  message: string;
}

export const MAX_BULK_ROWS = 500;

const isFiniteNonNegative = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * Validates the raw body shape. Returns ALL problems found across ALL rows
 * (not just the first) so the caller can report the full set in one response.
 */
export function validateBulkRows(body: unknown): {
  rows: BulkPriceRow[] | null;
  errors: BulkRowError[];
  tooMany: boolean;
} {
  const rawRows = (body as { rows?: unknown })?.rows;
  if (!Array.isArray(rawRows) || rawRows.length === 0) {
    return {
      rows: null,
      errors: [{ index: -1, variant_id: null, message: "rows must be a non-empty array" }],
      tooMany: false,
    };
  }

  if (rawRows.length > MAX_BULK_ROWS) {
    return { rows: null, errors: [], tooMany: true };
  }

  const errors: BulkRowError[] = [];

  rawRows.forEach((raw, index) => {
    const row = raw as Partial<BulkPriceRow> | null | undefined;
    const variant_id = row?.variant_id;
    const push = (message: string) =>
      errors.push({ index, variant_id: variant_id ?? null, message });

    if (typeof row?.variant_id !== "string" || row.variant_id.trim() === "") {
      push("variant_id must be a non-empty string");
    }
    if (typeof row?.product_id !== "string" || row.product_id.trim() === "") {
      push("product_id must be a non-empty string");
    }

    const hasCost = row?.cost !== undefined;
    const hasRetail = row?.retail_price !== undefined;
    const hasWholesale = row?.wholesale_price !== undefined;

    if (!hasCost && !hasRetail && !hasWholesale) {
      push("row must set at least one of cost, retail_price, wholesale_price");
    }

    // retail_price and wholesale_price no longer need to travel together —
    // a variant with no wholesale row mirrors retail as its effective
    // wholesale, so a retail-only change is valid on its own. When only ONE
    // side is provided, the shape validator can't compare it against
    // anything (the other side is whatever's live in DB) — that
    // cross-check happens at the caller (submit/approve/the write engine),
    // against a live snapshot, not here.
    if (hasCost && !isFiniteNonNegative(row!.cost)) {
      push("cost must be a finite number >= 0");
    }
    if (hasRetail && !isFiniteNonNegative(row!.retail_price)) {
      push("retail_price must be a finite number >= 0");
    }
    if (hasWholesale && !isFiniteNonNegative(row!.wholesale_price)) {
      push("wholesale_price must be a finite number >= 0");
    }

    if (
      hasRetail &&
      hasWholesale &&
      isFiniteNonNegative(row!.retail_price) &&
      isFiniteNonNegative(row!.wholesale_price) &&
      (row!.wholesale_price as number) > (row!.retail_price as number)
    ) {
      push("wholesale_price cannot exceed retail_price");
    }
  });

  if (errors.length > 0) {
    return { rows: null, errors, tooMany: false };
  }

  return { rows: rawRows as BulkPriceRow[], errors: [], tooMany: false };
}
