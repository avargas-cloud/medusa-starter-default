/**
 * Reclassifies the outsourced-services expense account from the PARENT
 * "Subcontractor Labor" to its sub-account
 * "Subcontractor Labor:Electrical/Construction Service" (owner decision,
 * 2026-09-10), in the three places the account lives:
 *
 *   1. `outsourced_service_type` — the mapping every FUTURE approval snapshots.
 *   2. `order_outsourced_service` — the snapshot already frozen on OSV-1001.
 *   3. `vendor_bill_line` of VB-1149 — what the QuickBooks Bill actually posts
 *      to; a BillMod is queued through the standard single-bill path so QB
 *      matches the POS (the Add path had already sent the parent).
 *
 * Every write is compare-and-swap on the OLD ListID: a row that moved since
 * the dry-run is left alone and the whole transaction aborts.
 *
 *   env DATABASE_URL=... DISABLE_SCHEDULED_JOBS=true QB_VENDOR_BILL_MODE=bill \
 *     npx medusa exec ./src/scripts/fix/reclass-osv-account-electrical.ts          # dry-run
 *   ... APPLY=true npx medusa exec ./src/scripts/fix/reclass-osv-account-electrical.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";
import { enqueueVendorBillModSingle } from "../../lib/purchase-orders/qb-vendor-bill-mod-enqueue";

const OLD_LIST_ID = "8000004B-1331664382"; // Subcontractor Labor
const NEW_LIST_ID = "80000073-1361986000"; // Subcontractor Labor:Electrical/Construction Service
const NEW_FULL_NAME = "Subcontractor Labor:Electrical/Construction Service";

const TYPE_IDS = (process.env.TYPE_IDS ?? "ostp_on_site_installation")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const SERVICE_NUMBERS = (process.env.SERVICE_NUMBERS ?? "1001")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean); // display_number is BIGINT; compared as text
const BILL_LINE_IDS = (
  process.env.BILL_LINE_IDS ?? "vbl_8dc2cf698ceb4476824bcb71f24e85af"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

interface KnexLike {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number }>;
  transaction: () => Promise<
    KnexLike & { commit: () => Promise<void>; rollback: () => Promise<void> }
  >;
}

// knex.raw expands a JS array bound to `?` into a comma list, which is NOT a
// Postgres array: pass an array LITERAL and cast it instead.
function pgArray(values: string[]): string {
  return `{${values.map((v) => `"${v.replace(/"/g, '\\"')}"`).join(",")}}`;
}

function expectRows(label: string, got: number | undefined, want: number) {
  if (got !== want) {
    throw new Error(`${label}: expected ${want} row(s), got ${got ?? 0}`);
  }
}

export default async function reclassOsvAccountElectrical({
  container,
}: ExecArgs) {
  const apply = process.env.APPLY === "true";
  const db = container.resolve("__pg_connection__") as unknown as KnexLike;

  const target = await db.raw(
    `SELECT qb_list_id, full_name FROM qb_account
      WHERE qb_list_id = ? AND is_active = true AND deleted_at IS NULL`,
    [NEW_LIST_ID]
  );
  if (target.rows[0]?.full_name !== NEW_FULL_NAME) {
    throw new Error(`target account mismatch: ${JSON.stringify(target.rows[0])}`);
  }

  const types = await db.raw(
    // The operator may already have typed the new ListID into Settings while
    // leaving the NAME behind (both are free-text inputs there): accept either
    // ListID and normalise the pair, but never touch a type on a third account.
    `SELECT id, code, qb_account_list_id, qb_account_full_name FROM outsourced_service_type
      WHERE id = ANY(?::text[]) AND deleted_at IS NULL
        AND qb_account_list_id IN (?, ?)
        AND (qb_account_list_id <> ? OR qb_account_full_name <> ?)`,
    [pgArray(TYPE_IDS), OLD_LIST_ID, NEW_LIST_ID, NEW_LIST_ID, NEW_FULL_NAME]
  );
  const services = await db.raw(
    `SELECT id, display_number, state, qb_account_full_name
       FROM order_outsourced_service
      WHERE display_number::text = ANY(?::text[]) AND deleted_at IS NULL AND qb_account_list_id = ?`,
    [pgArray(SERVICE_NUMBERS), OLD_LIST_ID]
  );
  const lines = await db.raw(
    `SELECT l.id, l.vendor_bill_id, b.number, b.status, b.qb_txn_id,
            l.qb_account_full_name, l.qb_txn_line_id
       FROM vendor_bill_line l
       JOIN vendor_bill b ON b.id = l.vendor_bill_id AND b.deleted_at IS NULL
      WHERE l.id = ANY(?::text[]) AND l.deleted_at IS NULL
        AND l.line_type = 'qb_account' AND l.qb_account_list_id = ?`,
    [pgArray(BILL_LINE_IDS), OLD_LIST_ID]
  );

  console.log(`Mode: ${apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`types    (${types.rows.length}/${TYPE_IDS.length}):`, types.rows);
  console.log(`services (${services.rows.length}/${SERVICE_NUMBERS.length}):`, services.rows);
  console.log(`lines    (${lines.rows.length}/${BILL_LINE_IDS.length}):`, lines.rows);

  if (
    types.rows.length !== TYPE_IDS.length ||
    services.rows.length !== SERVICE_NUMBERS.length ||
    lines.rows.length !== BILL_LINE_IDS.length
  ) {
    throw new Error("some targets are missing or no longer on the OLD account — refusing");
  }
  for (const l of lines.rows) {
    if (!l.qb_txn_id) throw new Error(`${String(l.number)} is not in QuickBooks`);
    if (!l.qb_txn_line_id) throw new Error(`${String(l.id)} has no TxnLineID`);
  }
  if (!apply) return;

  const trx = await db.transaction();
  try {
    const t = await trx.raw(
      `UPDATE outsourced_service_type
          SET qb_account_list_id = ?, qb_account_full_name = ?, updated_at = now()
        WHERE id = ANY(?::text[]) AND deleted_at IS NULL
          AND qb_account_list_id IN (?, ?)
          AND (qb_account_list_id <> ? OR qb_account_full_name <> ?)`,
      [NEW_LIST_ID, NEW_FULL_NAME, pgArray(TYPE_IDS), OLD_LIST_ID, NEW_LIST_ID, NEW_LIST_ID, NEW_FULL_NAME]
    );
    expectRows("outsourced_service_type", t.rowCount, TYPE_IDS.length);

    const s = await trx.raw(
      `UPDATE order_outsourced_service
          SET qb_account_list_id = ?, qb_account_full_name = ?, updated_at = now()
        WHERE display_number::text = ANY(?::text[]) AND deleted_at IS NULL AND qb_account_list_id = ?`,
      [NEW_LIST_ID, NEW_FULL_NAME, pgArray(SERVICE_NUMBERS), OLD_LIST_ID]
    );
    expectRows("order_outsourced_service", s.rowCount, SERVICE_NUMBERS.length);

    const l = await trx.raw(
      `UPDATE vendor_bill_line
          SET qb_account_list_id = ?, qb_account_full_name = ?, updated_at = now()
        WHERE id = ANY(?::text[]) AND deleted_at IS NULL AND qb_account_list_id = ?`,
      [NEW_LIST_ID, NEW_FULL_NAME, pgArray(BILL_LINE_IDS), OLD_LIST_ID]
    );
    expectRows("vendor_bill_line", l.rowCount, BILL_LINE_IDS.length);

    const billIds = [...new Set(lines.rows.map((r) => String(r.vendor_bill_id)))];
    for (const billId of billIds) {
      const mod = await enqueueVendorBillModSingle(trx as never, billId);
      console.log(`BillMod ${billId}:`, mod);
      if (!mod.queued) throw new Error(`BillMod not queued for ${billId}: ${mod.reason}`);
    }

    await trx.commit();
    console.log("COMMITTED");
  } catch (err) {
    await trx.rollback();
    throw err;
  }
}
