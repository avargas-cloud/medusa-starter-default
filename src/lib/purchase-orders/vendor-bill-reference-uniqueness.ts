type SqlClient = {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows: unknown[] }>;
};

export type DuplicateVendorBillReference = {
  id: string;
  number: string | null;
  reference_id: string;
};

export const VENDOR_BILL_REFERENCE_REQUIRED_BODY = {
  error:
    "Vendor PI / Commercial Invoice # is required before a Vendor Bill can be saved",
  code: "vendor_reference_required",
} as const;

export function normalizeRequiredVendorBillReference(
  reference: unknown
): string | null {
  if (typeof reference !== "string") return null;
  const normalized = reference.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeVendorBillReference(reference: string): string {
  return reference.trim().toLocaleLowerCase("en-US").replace(/[^a-z0-9]/g, "");
}

/**
 * Serializes writes for one vendor + normalized invoice number and returns the
 * existing live bill, if any. Call this inside the same transaction that writes
 * vendor_bill so concurrent requests cannot both pass the check.
 */
export async function findDuplicateVendorBillReference(
  db: SqlClient,
  input: {
    vendorId: string | null;
    referenceId: string | null;
    excludeBillId?: string;
  }
): Promise<DuplicateVendorBillReference | null> {
  if (!input.vendorId || !input.referenceId?.trim()) return null;

  const normalized = normalizeVendorBillReference(input.referenceId);
  if (!normalized) return null;

  const lockKey = `${input.vendorId}:${normalized}`;
  await db.raw(`SELECT pg_advisory_xact_lock(hashtextextended(?, 0))`, [
    lockKey,
  ]);

  const result = await db.raw(
    `SELECT id, number, reference_id
       FROM vendor_bill
      WHERE vendor_id = ?
        AND deleted_at IS NULL
        AND reference_id IS NOT NULL
        AND lower(regexp_replace(btrim(reference_id), '[^[:alnum:]]', '', 'g')) = ?
        AND (?::text IS NULL OR id <> ?)
      ORDER BY created_at
      LIMIT 1`,
    [
      input.vendorId,
      normalized,
      input.excludeBillId ?? null,
      input.excludeBillId ?? null,
    ]
  );

  return (result.rows[0] as DuplicateVendorBillReference | undefined) ?? null;
}
