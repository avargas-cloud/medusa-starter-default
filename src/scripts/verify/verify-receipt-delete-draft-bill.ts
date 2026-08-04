/**
 * verify-receipt-delete-draft-bill
 *
 * Pins the 2026-08-04 change to receipt deletion and receipt stock guards:
 *
 *   A DRAFT vendor bill no longer blocks deleting an item receipt (a draft is
 *   not an accounting fact; the bill's drift banner reports lines that lost
 *   their receipt). Only confirmed/synced bills still block.
 *
 *   Negative stock no longer blocks either — editing or deleting a receipt
 *   whose units already left is exactly the correction that has to be
 *   possible, and an inventory count settles the discrepancy.
 *
 * WHAT IT PINS
 *   1. The cascade is REAL: vendor_bill.purchase_order_receipt_id is
 *      ON DELETE CASCADE. This is the fact that makes the unbind load-bearing
 *      rather than decoration.
 *   2. CONTROL — deleting a receipt WITHOUT unbinding destroys the bill and
 *      its lines. Without this, assertion 3 would pass just as happily on a
 *      schema where nothing cascaded, and would prove nothing.
 *   3. unbindReceiptFromBills severs all THREE link shapes, and the bill then
 *      survives the very same delete that just destroyed it in step 2.
 *   4. A bill spanning several receipts keeps a valid primary pointer when one
 *      of them is unbound — the mirror is re-derived, not just blanked.
 *   5. The route's guards no longer name 'draft' (source-scraped: the SQL is
 *      inline in the route and cannot be imported).
 *   6. buildStockWarning — the real function, not a restatement: negative and
 *      below-reserved are reported, a healthy position is not, and one line
 *      never yields two warnings.
 *   7. Production shape (read-only): how many receipts this actually unblocks.
 *
 * Everything mutating happens inside ONE transaction that is ALWAYS rolled
 * back. It re-counts its own rows afterwards to prove it left nothing behind.
 *
 *   env DATABASE_URL=$(grep ^DATABASE_URL= .env | cut -d= -f2-) \
 *     npx medusa exec ./src/scripts/verify/verify-receipt-delete-draft-bill.ts
 *
 * Run it with `tsx` and it exits 0 WITHOUT EXECUTING — this is a `medusa exec`
 * script (`export default`). The silence of a verifier is not approval.
 */

import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";

import type { ExecArgs } from "@medusajs/framework/types";

import { buildStockWarning } from "../../lib/purchase-orders/receipt-stock-warnings";
import { unbindReceiptFromBills } from "../../lib/purchase-orders/unbind-receipt-from-bills";

type Raw = {
  raw: (sql: string, b?: unknown[]) => Promise<{ rows: unknown[] }>;
};
type Trx = Raw & { commit: () => Promise<void>; rollback: () => Promise<void> };

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

interface Fixture {
  poId: string;
  poLineId: string;
  receiptId: string;
  receiptLineId: string;
  billId: string;
  billLineId: string;
}

/**
 * Plants a PO → receipt → draft bill chain wired through ALL THREE link
 * shapes the delete guard knows about, so a fix that only handles one of them
 * cannot pass.
 */
async function plant(trx: Raw, seq: number): Promise<Fixture> {
  const f: Fixture = {
    poId: randomUUID(),
    poLineId: randomUUID(),
    receiptId: randomUUID(),
    receiptLineId: randomUUID(),
    billId: randomUUID(),
    billLineId: randomUUID(),
  };

  await trx.raw(
    `INSERT INTO purchase_order (id, vendor_id, stock_location_id, created_by_user_id)
     VALUES (?, 'vfix', 'slocfix', 'ufix')`,
    [f.poId]
  );
  await trx.raw(
    `INSERT INTO purchase_order_line
       (id, purchase_order_id, product_variant_id, inventory_item_id,
        sku_snapshot, description_snapshot, qty_ordered, unit_cost_cents, total_cents)
     VALUES (?, ?, 'varfix', 'iitemfix', 'SKU-FIX', 'fixture line', 20, 2610, 52200)`,
    [f.poLineId, f.poId]
  );
  await trx.raw(
    `INSERT INTO purchase_order_receipt
       (id, purchase_order_id, number, seq, received_at, received_by_user_id,
        stock_location_id, status)
     VALUES (?, ?, ?, ?, NOW(), 'ufix', 'slocfix', 'applied')`,
    [f.receiptId, f.poId, `RCP-FIX-${seq}`, 900000 + seq]
  );
  await trx.raw(
    `INSERT INTO purchase_order_receipt_line
       (id, purchase_order_receipt_id, purchase_order_line_id, purchase_order_id,
        product_variant_id, inventory_item_id, sku_snapshot, description_snapshot,
        qty_received_now)
     VALUES (?, ?, ?, ?, 'varfix', 'iitemfix', 'SKU-FIX', 'fixture line', 20)`,
    [f.receiptLineId, f.receiptId, f.poLineId, f.poId]
  );
  // Link shape A: the legacy mirror (this is the CASCADE edge).
  await trx.raw(
    `INSERT INTO vendor_bill (id, purchase_order_id, purchase_order_receipt_id,
                              status, bill_type, number)
     VALUES (?, ?, ?, 'draft', 'regular', ?)`,
    [f.billId, f.poId, f.receiptId, `VB-FIX-${seq}`]
  );
  // Link shape B: the new source of truth (receipt → bill).
  await trx.raw(
    `UPDATE purchase_order_receipt SET vendor_bill_id = ? WHERE id = ?`,
    [f.billId, f.receiptId]
  );
  // Link shape C: the per-line pointer (a bare column — it dangles, not cascades).
  await trx.raw(
    `INSERT INTO vendor_bill_line
       (id, vendor_bill_id, sku, description, qty, unit_cost_cents,
        purchase_order_line_id, receipt_line_id)
     VALUES (?, ?, 'SKU-FIX', 'fixture line', 20, 2610, ?, ?)`,
    [f.billLineId, f.billId, f.poLineId, f.receiptLineId]
  );

  return f;
}

async function billExists(trx: Raw, billId: string): Promise<boolean> {
  const r = await trx.raw(`SELECT 1 FROM vendor_bill WHERE id = ?`, [billId]);
  return r.rows.length > 0;
}

export default async function main({ container }: ExecArgs): Promise<void> {
  const knex = container.resolve("__pg_connection__") as Raw & {
    transaction?: () => Promise<Trx>;
  };
  if (!knex.transaction) {
    throw new Error("This verifier needs a transaction-capable connection");
  }

  // ── 1. Schema: the cascade this whole change has to survive ────────────────
  console.log("\nSchema — the cascade that makes the unbind load-bearing");
  const fk = await knex.raw(
    `SELECT c.confdeltype
       FROM pg_constraint c
      WHERE c.contype = 'f'
        AND c.conrelid = 'vendor_bill'::regclass
        AND c.confrelid = 'purchase_order_receipt'::regclass`
  );
  const delType = (fk.rows[0] as { confdeltype: string } | undefined)
    ?.confdeltype;
  check(
    "vendor_bill.purchase_order_receipt_id is ON DELETE CASCADE",
    delType === "c",
    delType === undefined
      ? "FK not found"
      : `confdeltype='${delType}' — if this became SET NULL, the unbind is now belt-and-suspenders and this file needs rewriting, not deleting`
  );

  // ── 2+3+4. Behaviour on fixtures, inside a doomed transaction ──────────────
  console.log("\nCascade, unbind, and the bill that has to survive");
  const trx = await knex.transaction();
  let plantedBillIds: string[] = [];
  try {
    // -- CONTROL: no unbind. The cascade must actually fire, or assertion 3
    // below is measuring nothing.
    const control = await plant(trx, 1);
    plantedBillIds.push(control.billId);
    check(
      "control fixture starts with its bill present",
      await billExists(trx, control.billId)
    );
    await trx.raw(`DELETE FROM purchase_order_receipt WHERE id = ?`, [
      control.receiptId,
    ]);
    check(
      "CONTROL — deleting the receipt WITHOUT unbinding destroys the draft bill",
      !(await billExists(trx, control.billId)),
      "the cascade did not fire; assertion 3 would then prove nothing"
    );
    const orphanLines = await trx.raw(
      `SELECT 1 FROM vendor_bill_line WHERE id = ?`,
      [control.billLineId]
    );
    check(
      "CONTROL — the bill's lines go with it",
      orphanLines.rows.length === 0
    );

    // -- THE FIX: same delete, unbound first.
    const guarded = await plant(trx, 2);
    plantedBillIds.push(guarded.billId);
    const result = await unbindReceiptFromBills(trx, guarded.receiptId);

    check(
      "unbind reports the bill it detached",
      result.unbound_bill_ids.includes(guarded.billId),
      `got ${JSON.stringify(result.unbound_bill_ids)}`
    );
    check(
      "unbind cleared the per-line receipt pointer",
      result.cleared_bill_lines === 1,
      `cleared ${result.cleared_bill_lines}`
    );

    const afterLink = await trx.raw(
      `SELECT
         (SELECT vendor_bill_id FROM purchase_order_receipt WHERE id = ?) AS receipt_to_bill,
         (SELECT purchase_order_receipt_id FROM vendor_bill WHERE id = ?) AS bill_to_receipt,
         (SELECT receipt_line_id FROM vendor_bill_line WHERE id = ?) AS line_to_receipt_line`,
      [guarded.receiptId, guarded.billId, guarded.billLineId]
    );
    const links = afterLink.rows[0] as {
      receipt_to_bill: string | null;
      bill_to_receipt: string | null;
      line_to_receipt_line: string | null;
    };
    check("link A severed (bill → primary receipt)", links.bill_to_receipt === null);
    check("link B severed (receipt → bill)", links.receipt_to_bill === null);
    check(
      "link C severed (bill line → receipt line)",
      links.line_to_receipt_line === null
    );

    await trx.raw(`DELETE FROM purchase_order_receipt WHERE id = ?`, [
      guarded.receiptId,
    ]);
    check(
      "THE FIX — after unbinding, the same delete leaves the draft bill standing",
      await billExists(trx, guarded.billId)
    );
    const survivingLines = await trx.raw(
      `SELECT 1 FROM vendor_bill_line WHERE id = ?`,
      [guarded.billLineId]
    );
    check(
      "the bill keeps its lines, so its drift banner has something to report",
      survivingLines.rows.length === 1
    );

    // -- A bill spanning TWO receipts: the mirror is re-derived, not blanked.
    const shared = await plant(trx, 3);
    plantedBillIds.push(shared.billId);
    const secondReceiptId = randomUUID();
    await trx.raw(
      `INSERT INTO purchase_order_receipt
         (id, purchase_order_id, number, seq, received_at, received_by_user_id,
          stock_location_id, status, vendor_bill_id)
       VALUES (?, ?, 'RCP-FIX-3B', 900103, NOW(), 'ufix', 'slocfix', 'applied', ?)`,
      [secondReceiptId, shared.poId, shared.billId]
    );
    await unbindReceiptFromBills(trx, shared.receiptId);
    const primary = await trx.raw(
      `SELECT purchase_order_receipt_id AS p FROM vendor_bill WHERE id = ?`,
      [shared.billId]
    );
    check(
      "a bill spanning 2 receipts re-points its primary at the one still bound",
      (primary.rows[0] as { p: string | null }).p === secondReceiptId,
      `got ${JSON.stringify((primary.rows[0] as { p: string | null }).p)}`
    );

    // -- A SOFT-DELETED bill. This is the case the blanket UPDATE in step 4 of
    // the helper exists for, and the only one that distinguishes it from
    // syncPrimaryReceiptPointer — which ends in `AND deleted_at IS NULL` and
    // therefore cannot clear the pointer of a soft-deleted row. A soft-deleted
    // bill still owns a row, so it still cascades.
    //
    // This assertion was ADDED after a mutation test embarrassed the first
    // draft of this file: commenting out step 4 left all 22 checks green,
    // because every fixture used a live bill and step 5 covered for it.
    const softDeleted = await plant(trx, 4);
    plantedBillIds.push(softDeleted.billId);
    await trx.raw(
      `UPDATE vendor_bill SET deleted_at = NOW(), status = 'deleted' WHERE id = ?`,
      [softDeleted.billId]
    );
    await unbindReceiptFromBills(trx, softDeleted.receiptId);
    await trx.raw(`DELETE FROM purchase_order_receipt WHERE id = ?`, [
      softDeleted.receiptId,
    ]);
    check(
      "a SOFT-DELETED bill also survives the delete (step 4 of the unbind)",
      await billExists(trx, softDeleted.billId),
      "the blanket vendor_bill UPDATE is missing — syncPrimaryReceiptPointer cannot reach a soft-deleted row"
    );

    // -- Idempotence: a second unbind finds nothing and breaks nothing.
    const again = await unbindReceiptFromBills(trx, guarded.receiptId);
    check(
      "unbind is idempotent — a second call detaches nothing",
      again.cleared_bill_lines === 0
    );
  } finally {
    await trx.rollback();
  }

  // -- And it left nothing behind.
  const leftovers = await knex.raw(
    `SELECT COUNT(*)::int AS n FROM vendor_bill WHERE id = ANY(?)`,
    [plantedBillIds]
  );
  check(
    "rollback left no fixture rows behind",
    (leftovers.rows[0] as { n: number }).n === 0
  );

  // ── 5. The route's guards, source-scraped ─────────────────────────────────
  // The guard SQL is inline in the route handler, so there is no function to
  // call. Scraping the source is weaker than calling it — but a guard that
  // silently regains 'draft' is exactly the regression worth catching, and
  // asserting nothing would be weaker still.
  console.log("\nRoute guards no longer treat a draft bill as blocking");
  const routePath = join(
    process.cwd(),
    "src/api/admin/purchase-orders/[id]/receipts/[receiptId]/route.ts"
  );
  const routeSrc = readFileSync(routePath, "utf8");
  const draftBlocking = routeSrc.match(/IN \('draft', 'confirmed', 'synced'\)/g);
  check(
    "no guard query still lists 'draft' alongside confirmed/synced",
    draftBlocking === null,
    `found ${draftBlocking?.length ?? 0} occurrence(s)`
  );
  check(
    "the posted-bill guard still blocks confirmed/synced",
    (routeSrc.match(/IN \('confirmed', 'synced'\)/g)?.length ?? 0) >= 2,
    "expected the active-billing guard AND the billed-floor guard"
  );
  check(
    "the delete path still calls the unbind before destroying the row",
    readFileSync(
      join(
        process.cwd(),
        "src/workflows/purchase-orders/steps/persist-delete-receipt-step.ts"
      ),
      "utf8"
    ).includes("unbindReceiptFromBills"),
    "without this the cascade proven in step 2 is live in production"
  );

  // ── 6. The stock warning — the real function ──────────────────────────────
  console.log("\nStock warnings (calling the shipped function, not a copy)");
  const negative = buildStockWarning({
    receipt_line_id: "rl",
    inventory_item_id: "ii",
    sku: "SKU-FIX",
    stock_before: 18,
    stock_after: -2,
    reserved: 1,
  });
  check(
    "stock going negative is reported as stock_goes_negative",
    negative?.code === "stock_goes_negative",
    `got ${negative?.code ?? "null"}`
  );
  check(
    "the message names the resulting position",
    !!negative?.message.includes("-2"),
    negative?.message
  );

  const belowReserved = buildStockWarning({
    receipt_line_id: "rl",
    inventory_item_id: "ii",
    sku: null,
    stock_before: 18,
    stock_after: 0,
    reserved: 1,
  });
  check(
    "landing below reserved is reported as stock_below_reserved",
    belowReserved?.code === "stock_below_reserved",
    `got ${belowReserved?.code ?? "null"}`
  );

  check(
    "a healthy position produces NO warning",
    buildStockWarning({
      receipt_line_id: "rl",
      inventory_item_id: "ii",
      sku: null,
      stock_before: 18,
      stock_after: 3,
      reserved: 1,
    }) === null
  );
  check(
    "exactly at the reserved floor is not a warning",
    buildStockWarning({
      receipt_line_id: "rl",
      inventory_item_id: "ii",
      sku: null,
      stock_before: 18,
      stock_after: 1,
      reserved: 1,
    }) === null
  );

  // ── 7. Production shape (read-only) ───────────────────────────────────────
  console.log("\nProduction shape — what this unblocks (read-only)");
  const shape = await knex.raw(
    `SELECT
       COUNT(*) FILTER (WHERE vb.status = 'draft')                  AS draft_linked,
       COUNT(*) FILTER (WHERE vb.status IN ('confirmed','synced'))  AS posted_linked
       FROM purchase_order_receipt por
       JOIN vendor_bill vb ON vb.id = por.vendor_bill_id
      WHERE por.deleted_at IS NULL
        AND vb.deleted_at IS NULL
        AND por.status IN ('applied','synced','voided')`
  );
  const row = shape.rows[0] as {
    draft_linked: string | number;
    posted_linked: string | number;
  };
  console.log(
    `  · receipts bound to a DRAFT bill (deletable now, blocked before): ${row.draft_linked}`
  );
  console.log(
    `  · receipts bound to a POSTED bill (still blocked, by design):     ${row.posted_linked}`
  );

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) {
    throw new Error(`verify-receipt-delete-draft-bill: ${fail} check(s) failed`);
  }
}
