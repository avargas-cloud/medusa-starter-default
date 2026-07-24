/**
 * Reprice the receipt-to-confirm window for a vendor bill, after the fact.
 *
 * The confirm route does this automatically, but non-fatally: a bill that is
 * already confirmed must stand even if the repricing trips. When it does, the
 * log points here.
 *
 * Also useful for bills confirmed BEFORE the automatic step shipped — their
 * windows were never repriced (the one-off China restatement covered the
 * historical ones, but a bill confirmed in the gap between that run and this
 * deploy would be missed).
 *
 * USAGE
 *   env DATABASE_URL="$(grep ^DATABASE_URL= .env | cut -d= -f2-)" BILL_ID=vb_… \
 *     ./node_modules/.bin/medusa exec ./src/scripts/fix/recost-vendor-bill-window.ts
 *
 *   APPLY=true    write (default is a dry run)
 *   ALL=true      every confirmed bill instead of one, oldest first
 */

import { recostSalesWindow, type RecostKnex } from "../../lib/cost/recost-window";

interface BillRow {
  id: string;
  number: string | null;
  confirmed_at: string | Date;
  received_at: string | Date | null;
}

/**
 * A bill's variants and the earliest arrival across the receipts it covers.
 * The window opens when the goods landed, not when the paperwork caught up.
 */
const BILLS_SQL = `
SELECT vb.id, vb.number, vb.confirmed_at, r.received_at
  FROM vendor_bill vb
  LEFT JOIN purchase_order_receipt r
         ON r.id = vb.purchase_order_receipt_id AND r.deleted_at IS NULL AND r.voided_at IS NULL
 WHERE vb.deleted_at IS NULL
   AND vb.status = 'confirmed'
   AND (?::text IS NULL OR vb.id = ?::text)
 ORDER BY vb.confirmed_at
`;

/**
 * The cost each variant reached AT THIS BILL, from the rebuilt cost timeline.
 *
 * Source is `variant_cost_event`, NOT `vendor_bill_cost_log`. The log's
 * `new_avg_cost_cents` is the output of the old averaging bug — the very values
 * the restatement threw away and recomputed. Reading it here re-applied the
 * corruption: a first pass over production's history moved 428 lines and pushed
 * COGS $1,272 the wrong way, when a correct pass should barely move anything at
 * all, because the restatement already priced these windows.
 *
 * The cost events are the reconstruction; the log is the raw observation that
 * fed it.
 */
const VARIANT_COSTS_SQL = `
SELECT DISTINCT ON (e.product_variant_id)
       e.product_variant_id AS variant_id,
       e.new_unit_cost      AS new_cost,
       -- Each variant's own arrival, not the bill's earliest: one bill can
       -- cover receipts that landed days apart, and a variant only rides on
       -- some of them.
       e.effective_at       AS window_start
  FROM variant_cost_event e
 WHERE e.vendor_bill_id = ?
   AND e.status = 'active'
   AND e.cost_field = 'average_cost'
 ORDER BY e.product_variant_id, e.effective_at DESC, e.economic_sequence DESC
`;

const iso = (raw: unknown): string =>
  raw instanceof Date ? raw.toISOString() : String(raw ?? "");

export default async function recostVendorBillWindow({
  container,
}: {
  container: { resolve: (key: string) => unknown };
}) {
  const knex = container.resolve("__pg_connection__") as RecostKnex;
  const apply = process.env.APPLY === "true";
  const billId = process.env.BILL_ID ?? null;
  const all = process.env.ALL === "true";

  if (!billId && !all) {
    throw new Error("Pasá BILL_ID=<id> o ALL=true.");
  }

  const { rows } = await knex.raw(BILLS_SQL, [billId, billId]);
  const bills = rows as BillRow[];
  if (bills.length === 0) {
    console.log("No se encontró ningún vendor bill confirmado con ese criterio.");
    return { bills: 0, repriced: 0 };
  }

  console.log("═".repeat(88));
  console.log(`  RE-COSTEO DE LA VENTANA RECEPCION → CONFIRMACION  (${apply ? "APPLY" : "DRY RUN"})`);
  console.log("═".repeat(88));

  let totalInvoice = 0;
  let totalMemo = 0;
  let totalDeltaCents = 0;
  let skipped = 0;

  for (const bill of bills) {
    if (!bill.received_at) {
      console.log(`  ${bill.number ?? bill.id}: sin receipt ancla vivo — se saltea`);
      skipped++;
      continue;
    }

    const variantsResult = await knex.raw(VARIANT_COSTS_SQL, [bill.id]);
    const events = (
      variantsResult.rows as Array<{
        variant_id: string;
        new_cost: string | number;
        window_start: string | Date;
      }>
    ).map((row) => ({
      variantId: row.variant_id,
      newCost: Number(row.new_cost),
      from: new Date(iso(row.window_start)),
    }));
    if (events.length === 0) {
      skipped++;
      continue;
    }

    const from = new Date(iso(bill.received_at));
    const result = await recostSalesWindow(knex, {
      events,
      runId: `rw_${bill.id}`,
      reason: "receipt_to_bill_window",
      dryRun: !apply,
    });

    const moved = result.invoiceLinesRepriced + result.creditMemoLinesRepriced;
    if (moved === 0) {
      continue;
    }

    totalInvoice += result.invoiceLinesRepriced;
    totalMemo += result.creditMemoLinesRepriced;
    totalDeltaCents += result.cogsDeltaCents;

    const lag = Math.round(
      (new Date(iso(bill.confirmed_at)).getTime() - from.getTime()) / 86_400_000
    );
    console.log("");
    console.log(
      `  ${bill.number ?? bill.id}  recibido ${iso(bill.received_at).slice(0, 10)} · ` +
        `confirmado ${iso(bill.confirmed_at).slice(0, 10)} (${lag} días de ventana)`
    );
    console.log(
      `    ${result.invoiceLinesRepriced} invoices · ${result.creditMemoLinesRepriced} notas · ` +
        `COGS ${(result.cogsDeltaCents / 100).toFixed(2)} · ${result.alreadyCorrect} ya estaban bien`
    );
    for (const detail of result.details.slice(0, 8)) {
      console.log(
        `      ${detail.sku}  ${detail.quantity} u  ` +
          `${detail.fromCost === null ? "—" : detail.fromCost.toFixed(4)} → ${detail.toCost.toFixed(4)}`
      );
    }
    if (result.details.length > 8) {
      console.log(`      … y ${result.details.length - 8} líneas más`);
    }
  }

  console.log("");
  console.log("─".repeat(88));
  console.log(
    `  ${bills.length} bills revisados · ${totalInvoice} invoices y ${totalMemo} notas repreciadas · ` +
      `COGS ${(totalDeltaCents / 100).toFixed(2)}`
  );
  if (skipped > 0) console.log(`  ${skipped} salteados (sin receipt ancla o sin líneas de producto)`);
  if (!apply) {
    console.log("");
    console.log("DRY RUN — no se escribió nada. APPLY=true para aplicar.");
  }

  return {
    bills: bills.length,
    invoiceLines: totalInvoice,
    creditMemoLines: totalMemo,
    cogsDeltaCents: totalDeltaCents,
  };
}
