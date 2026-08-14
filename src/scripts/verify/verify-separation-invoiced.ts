/**
 * Gate for the separation-vs-invoiced derivation (2026-08-14).
 *
 * Two invariants, both against the LIVE database:
 *
 * 1. FLAG PARITY — for every open order, the stored
 *    `metadata.fully_invoiced` equals what `loadFullyInvoicedForOrder`
 *    computes right now (absent counts as false). A mismatch means either the
 *    subscriber stamp regressed or the backfill hasn't run.
 *
 * 2. LIST↔MODAL PARITY — for every open order the list flags as having units
 *    to separate (and every one carrying invoiced-but-unattributed items),
 *    `loadSeparationPending`'s `pending` equals the pending derived from
 *    `loadSeparationData`, the modal's own loader:
 *    Σ max(0, (quantity − covered) − separated). These are two independent
 *    implementations of "invoiced units are done" (SQL+allocator vs
 *    modal loader), so agreement is the check — the list contradicting the
 *    screen the operator opens next is exactly the bug class this guards.
 *
 * Run (medusa exec — running it with tsx executes NOTHING and exits 0):
 *   env DATABASE_URL=... npx medusa exec ./src/scripts/verify/verify-separation-invoiced.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";

import { getDbPool } from "../../api/utils/db-pool";
import { loadSeparationData } from "../../api/admin/orders/[id]/_lib/separation-data";
import { loadSeparationPending } from "../../api/admin/orders/_lib/separation-availability";
import { loadFullyInvoicedForOrder } from "../../lib/invoices/load-fully-invoiced";

export default async function verifySeparationInvoiced({
  container,
}: ExecArgs): Promise<void> {
  const query = container.resolve("query");
  const knex = container.resolve("__pg_connection__") as {
    raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
  };
  const pool = getDbPool();
  let failures = 0;

  const { data: orders } = await query.graph({
    entity: "order",
    fields: ["id", "display_id", "status", "is_draft_order", "metadata"],
    pagination: { take: null },
  });
  const open = (orders ?? []).filter(
    (o: any) =>
      o?.is_draft_order !== true &&
      !["completed", "canceled", "archived", "draft"].includes(o?.status)
  );

  // ── 1. flag parity ────────────────────────────────────────────────────────
  let flagMismatches = 0;
  for (const o of open) {
    const stored = (o.metadata ?? {}).fully_invoiced === true;
    const computed = await loadFullyInvoicedForOrder(o.id, container);
    if (stored !== computed) {
      flagMismatches++;
      console.log(
        `  ❌ S${o.display_id}: stored fully_invoiced=${stored}, computed=${computed}`
      );
    }
  }
  if (flagMismatches) failures++;
  console.log(
    `[1] fully_invoiced parity over ${open.length} open orders: ${
      flagMismatches === 0 ? "OK" : `${flagMismatches} mismatch(es)`
    }`
  );

  // ── 2. list ↔ modal pending parity ───────────────────────────────────────
  const openIds = open.map((o: any) => o.id);
  const pendingByOrder = await loadSeparationPending(knex, openIds);

  // Check every order the list says has pending work, plus every order with
  // unattributed invoiced items (the population the allocator exists for) —
  // including those the list reports as fully covered, so a list that
  // UNDER-reports pending cannot pass by omission.
  const withUnattributed = new Set(
    (
      (
        await knex.raw(
          `SELECT DISTINCT pi.order_id
             FROM pos_invoice pi
             JOIN pos_invoice_item pii
               ON pii.invoice_id = pi.id AND pii.deleted_at IS NULL
            WHERE pi.deleted_at IS NULL
              AND pi.status NOT IN ('voided', 'draft')
              AND pii.order_line_item_id IS NULL
              AND pi.order_id = ANY(?::text[])`,
          [openIds]
        )
      ).rows as Array<{ order_id: string }>
    ).map((r) => r.order_id)
  );
  const toCheck = open.filter(
    (o: any) =>
      (pendingByOrder.get(o.id)?.pending ?? 0) > 0 || withUnattributed.has(o.id)
  );

  let pendingMismatches = 0;
  for (const o of toCheck) {
    const data = await loadSeparationData(pool, o.id);
    if (!data) continue;
    const modalPending = data.lines.reduce(
      (sum, l) =>
        sum +
        Math.max(0, Math.max(0, l.quantity - l.fulfilled) - l.separated),
      0
    );
    const listPending = pendingByOrder.get(o.id)?.pending ?? 0;
    if (modalPending !== listPending) {
      pendingMismatches++;
      console.log(
        `  ❌ S${o.display_id}: list pending=${listPending}, modal pending=${modalPending}`
      );
    }
  }
  if (pendingMismatches) failures++;
  console.log(
    `[2] list↔modal pending parity over ${toCheck.length} order(s): ${
      pendingMismatches === 0 ? "OK" : `${pendingMismatches} mismatch(es)`
    }`
  );

  if (failures) {
    throw new Error(
      `[verify-separation-invoiced] ${failures} section(s) FAILED`
    );
  }
  console.log("[verify-separation-invoiced] ✅ all sections OK");
}
