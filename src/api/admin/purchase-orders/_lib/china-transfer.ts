/**
 * src/api/admin/purchase-orders/_lib/china-transfer.ts
 *
 * Derives whether a Purchase Order to the China purchasing agent (e.g. Veetech)
 * is missing its required Inventory Transfer (IT). A PO whose vendor is flagged
 * `metadata.is_china_agent = true` MUST get a linked IT so China reservations
 * are created — otherwise the received stock lands as phantom inventory.
 *
 * The agent flag lives on `qb_vendor.metadata.is_china_agent` (no schema column;
 * see project_qb_vendor_no_meili_trigger + the PATCH metadata-merge path). All
 * "is this the agent?" checks are LIVE against the vendor row — never the PO's
 * snapshot — so toggling a vendor retroactively lights up / clears the badges.
 *
 * IMPORTANT: knex here is the `__pg_connection__` pool → `?` placeholders (NOT
 * `$1`), and the JSONB `?` operator must be avoided (it collides with bindings).
 */

/** SQL boolean fragment; expects the qb_vendor row aliased as `v`. */
export const VENDOR_IS_CHINA_AGENT_SQL = `(
  v.metadata @> '{"is_china_agent": true}'::jsonb
  OR lower(v.metadata->>'is_china_agent') = 'true'
)`;

export type ChinaTransferState =
  | "not_required" // vendor is not a China agent
  | "linked" // active IT exists
  | "missing_convertible" // no IT, submitted/partially_received, 0 received → can auto-convert
  | "missing_after_receipt" // no IT but units already received → convert blocked, needs manual fix
  | "not_convertible_status"; // no IT, in a status where conversion isn't offered (draft/closed/…)

export interface ChinaTransferInfo {
  required: boolean;
  has_linked_transfer: boolean;
  state: ChinaTransferState;
}

const TERMINAL_STATUSES = new Set(["cancelled", "voided"]);

/**
 * Pure state machine. `unitsReceived` is the PO's total_units_received.
 */
export function deriveChinaTransferState(args: {
  required: boolean;
  hasLinkedTransfer: boolean;
  status: string;
  unitsReceived: number;
}): ChinaTransferInfo {
  const { required, hasLinkedTransfer, status, unitsReceived } = args;

  if (!required) {
    return { required: false, has_linked_transfer: hasLinkedTransfer, state: "not_required" };
  }
  if (hasLinkedTransfer) {
    return { required: true, has_linked_transfer: true, state: "linked" };
  }
  // Missing IT branch.
  let state: ChinaTransferState;
  if (TERMINAL_STATUSES.has(status)) {
    state = "not_convertible_status";
  } else if (unitsReceived > 0) {
    state = "missing_after_receipt";
  } else if (status === "submitted" || status === "partially_received") {
    state = "missing_convertible";
  } else {
    // draft / closed with 0 received: nothing to convert (yet).
    state = "not_convertible_status";
  }
  return { required: true, has_linked_transfer: false, state };
}

type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

/**
 * Enrich a page of already-loaded PO rows with china_transfer info via a single
 * raw query keyed by PO ids. Does NOT touch pagination/counts — safe to run on
 * the paginated slice. Use the base-query join instead only if you add a
 * server-side "IT Missing" filter/tab (else counts would be wrong).
 */
export async function enrichChinaTransferMap(
  knex: Knex,
  rows: Array<{ id: string; status: string; total_units_received?: number | null; vendor_id: string }>
): Promise<Map<string, ChinaTransferInfo>> {
  const out = new Map<string, ChinaTransferInfo>();
  if (rows.length === 0) return out;

  const ids = rows.map((r) => r.id);
  const result = (await knex.raw(
    `SELECT po.id AS id,
            ${VENDOR_IS_CHINA_AGENT_SQL} AS vendor_is_china_agent,
            EXISTS (
              SELECT 1 FROM inventory_transfer it
               WHERE it.linked_purchase_order_id = po.id
                 AND it.status <> 'voided'
                 AND it.deleted_at IS NULL
            ) AS has_linked_transfer
       FROM purchase_order po
       LEFT JOIN qb_vendor v ON v.id = po.vendor_id AND v.deleted_at IS NULL
      WHERE po.id = ANY (?::text[])`,
    [ids]
  )) as { rows: Array<{ id: string; vendor_is_china_agent: boolean; has_linked_transfer: boolean }> };

  const byId = new Map(result.rows.map((r) => [r.id, r]));
  for (const row of rows) {
    const enr = byId.get(row.id);
    out.set(
      row.id,
      deriveChinaTransferState({
        required: Boolean(enr?.vendor_is_china_agent),
        hasLinkedTransfer: Boolean(enr?.has_linked_transfer),
        status: row.status,
        unitsReceived: Number(row.total_units_received ?? 0),
      })
    );
  }
  return out;
}

/** True when the vendor row is flagged as the China purchasing agent. */
export async function vendorIsChinaAgent(knex: Knex, vendorId: string): Promise<boolean> {
  const r = (await knex.raw(
    `SELECT ${VENDOR_IS_CHINA_AGENT_SQL} AS is_agent
       FROM qb_vendor v
      WHERE v.id = ? AND v.deleted_at IS NULL
      LIMIT 1`,
    [vendorId]
  )) as { rows: Array<{ is_agent: boolean }> };
  return Boolean(r.rows[0]?.is_agent);
}

/** True when the PO has an active (non-voided) linked Inventory Transfer. */
export async function hasActiveLinkedTransfer(knex: Knex, poId: string): Promise<boolean> {
  const r = (await knex.raw(
    `SELECT EXISTS (
       SELECT 1 FROM inventory_transfer
        WHERE linked_purchase_order_id = ?
          AND status <> 'voided'
          AND deleted_at IS NULL
     ) AS has_it`,
    [poId]
  )) as { rows: Array<{ has_it: boolean }> };
  return Boolean(r.rows[0]?.has_it);
}
