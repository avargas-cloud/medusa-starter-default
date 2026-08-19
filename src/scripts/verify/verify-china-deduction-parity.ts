/**
 * verify-china-deduction-parity
 *
 * Gate for the China side of a Transfer-to-USA purchase order.
 *
 * WHAT IT PROVES
 * That no linked inventory transfer is sitting in a state where China stock was
 * moved (or should have been) without the transfer recording it. That state is
 * what `onPoReceiveApplied`'s old `["shipped"]` gate produced: a PO that keeps
 * receiving after its transfer closed returned early, so China was never
 * debited, the reservation never released, and qty_received never bumped —
 * silently, with every screen green. Measured in production on 2026-08-19:
 * 56 units of phantom China stock across RCP-1106, RCP-1142 and RCP-1198.
 *
 * WHY THESE CHECKS AND NOT A TIMESTAMP COMPARISON
 * The obvious probe — "an applied receipt dated after its IT closed" — is a
 * fingerprint of the past, not an invariant: repairing the data does not make it
 * false, so the gate would stay red forever and get muted. Every check below is
 * a statement about the CURRENT state that the fixed code cannot produce.
 *
 * FAIL (exit 1):
 *   A. An IT line records less received than its PO line actually received.
 *      This is the single condition both halves of the bug land on: the China
 *      debit and the qty_received bump happen in the same loop, so a short
 *      qty_received means that loop never ran for those units.
 *   B. A live China reservation owned by a transfer that is received or voided.
 *      Receiving releases; voiding releases. A survivor is stock held against a
 *      shipment that is over.
 *   C. A transfer marked 'received' that still carries outstanding units. Both
 *      fixes demote such a transfer back to 'shipped'; if one is reverted this
 *      goes red, which is exactly the mutation test.
 *
 * Run:
 *   env DATABASE_URL="$(grep ^DATABASE_URL= backend/.env | cut -d= -f2-)" \
 *     ./node_modules/.bin/tsx src/scripts/verify/verify-china-deduction-parity.ts
 */

import { Client } from "pg";

interface ShortReceiptRow {
  it_number: string;
  it_status: string;
  po_number: string;
  sku: string;
  it_qty: number;
  it_qty_received: number;
  po_received: number;
  missing: number;
}

interface OrphanReservationRow {
  it_number: string;
  it_status: string;
  description: string;
  quantity: number;
  created_at: string;
}

interface OutstandingRow {
  it_number: string;
  po_number: string | null;
  short_lines: number;
  outstanding_units: number;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const client = new Client({ connectionString: url });
  await client.connect();

  let failures = 0;

  try {
    // ── A. IT line records less received than the PO actually received ────
    //
    // Scoped to lines that already existed when the goods arrived
    // (`itl.created_at <= r.received_at`). A line mirrored onto the transfer
    // AFTER the fact never had a bump to miss, and China was still debited
    // correctly because onPoReceiveApplied iterates the RECEIPT's lines, not
    // the transfer's — the 2026-07-17 backfill created nine such rows and
    // failing on them would be an accusation with no defect behind it.
    const shortReceipt = await client.query<ShortReceiptRow>(
      `WITH received_before AS (
         SELECT rl.purchase_order_line_id AS pol_id,
                itl.id                    AS itl_id,
                SUM(rl.qty_received_now)  AS po_received
           FROM purchase_order_receipt_line rl
           JOIN purchase_order_receipt r
             ON r.id = rl.purchase_order_receipt_id
            AND r.deleted_at IS NULL
            AND r.status = 'applied'
           JOIN inventory_transfer_line itl
             ON itl.purchase_order_line_id = rl.purchase_order_line_id
            AND itl.deleted_at IS NULL
            AND itl.created_at <= r.received_at
          WHERE rl.deleted_at IS NULL
          GROUP BY rl.purchase_order_line_id, itl.id
       )
       SELECT it.number  AS it_number,
              it.status  AS it_status,
              po.number  AS po_number,
              itl.sku,
              itl.qty            AS it_qty,
              itl.qty_received   AS it_qty_received,
              rb.po_received::int,
              (LEAST(rb.po_received, itl.qty) - itl.qty_received)::int AS missing
         FROM received_before rb
         JOIN inventory_transfer_line itl ON itl.id = rb.itl_id
         JOIN inventory_transfer it
           ON it.id = itl.transfer_id
          AND it.deleted_at IS NULL
          AND it.voided_at IS NULL
         JOIN purchase_order po ON po.id = it.linked_purchase_order_id
        WHERE LEAST(rb.po_received, itl.qty) > itl.qty_received
        ORDER BY it.number, itl.sku`
    );

    if (shortReceipt.rows.length > 0) {
      failures += shortReceipt.rows.length;
      const units = shortReceipt.rows.reduce((sum, r) => sum + r.missing, 0);
      console.error(
        `✗ IT lines recording less than the PO received (${shortReceipt.rows.length} lines, ${units} units):`
      );
      for (const r of shortReceipt.rows) {
        console.error(
          `  ${r.it_number} [${r.it_status}] ${r.po_number} ${r.sku}: ` +
            `IT ${r.it_qty_received}/${r.it_qty} received, PO received ${r.po_received} → ${r.missing} unaccounted`
        );
      }
    } else {
      console.log("✓ Every IT line records what its PO line received");
    }

    // ── B. Live China reservation owned by a closed transfer ──────────────
    const orphans = await client.query<OrphanReservationRow>(
      `SELECT it.number AS it_number, it.status AS it_status,
              ri.description, ri.quantity::int, ri.created_at
         FROM reservation_item ri
         JOIN inventory_transfer it
           ON it.id = ri.metadata->>'inventory_transfer_id'
        WHERE ri.deleted_at IS NULL
          AND (it.status IN ('received', 'voided') OR it.voided_at IS NOT NULL)
        ORDER BY it.number`
    );

    if (orphans.rows.length > 0) {
      failures += orphans.rows.length;
      console.error(`✗ China reservations held by closed transfers (${orphans.rows.length}):`);
      for (const r of orphans.rows) {
        console.error(
          `  ${r.it_number} [${r.it_status}] ${r.description}: ${r.quantity} units, created ${r.created_at}`
        );
      }
    } else {
      console.log("✓ No China reservation outlives its transfer");
    }

    // ── C. A 'received' transfer that still owes units ────────────────────
    const outstanding = await client.query<OutstandingRow>(
      `SELECT it.number AS it_number, po.number AS po_number,
              COUNT(*)::int AS short_lines,
              SUM(itl.qty - itl.qty_received)::int AS outstanding_units
         FROM inventory_transfer it
         JOIN inventory_transfer_line itl
           ON itl.transfer_id = it.id AND itl.deleted_at IS NULL
         LEFT JOIN purchase_order po ON po.id = it.linked_purchase_order_id
        WHERE it.status = 'received'
          AND it.deleted_at IS NULL
          AND it.voided_at IS NULL
          AND itl.qty_received < itl.qty
        GROUP BY it.number, po.number
        ORDER BY it.number`
    );

    if (outstanding.rows.length > 0) {
      failures += outstanding.rows.length;
      console.error(`✗ Transfers marked received with units outstanding (${outstanding.rows.length}):`);
      for (const r of outstanding.rows) {
        console.error(
          `  ${r.it_number} (${r.po_number ?? "no PO"}): ${r.short_lines} line(s), ${r.outstanding_units} units still owed`
        );
      }
    } else {
      console.log("✓ No transfer is marked received while units are outstanding");
    }
  } finally {
    await client.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL — ${failures} problem(s)`);
    process.exit(1);
  }
  console.log("\nPASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
