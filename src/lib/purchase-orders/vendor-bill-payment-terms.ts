type PaymentTermsKnex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

const DEFAULT_TERMS_DAYS = 0;
const MAX_TERMS_DAYS = 365;

/**
 * Resolves the operator-managed Vendor Bill terms stored on qb_vendor metadata.
 * Missing or invalid metadata intentionally falls back to Due on Receipt.
 */
export async function resolveVendorBillPaymentTermsDays(
  knex: PaymentTermsKnex,
  vendorId: string | null | undefined
): Promise<number> {
  if (!vendorId) return DEFAULT_TERMS_DAYS;

  const result = await knex.raw(
    `SELECT metadata->>'default_payment_terms_days' AS payment_terms_days
       FROM qb_vendor
      WHERE id = ? AND deleted_at IS NULL
      LIMIT 1`,
    [vendorId]
  );
  const raw = (result.rows[0] as { payment_terms_days?: unknown } | undefined)
    ?.payment_terms_days;
  const days = Number(raw);

  return Number.isInteger(days) && days >= 0 && days <= MAX_TERMS_DAYS
    ? days
    : DEFAULT_TERMS_DAYS;
}

