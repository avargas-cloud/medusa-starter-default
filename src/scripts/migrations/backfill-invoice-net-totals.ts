/**
 * backfill-invoice-net-totals.ts
 *
 * Freezes `net_total_cents` on EXISTING `pos_invoice_item` rows so historical
 * documents keep EXACTLY the value they were billed at, even after the live
 * discount math switched to round-then-multiply (2026-05-29).
 *
 * It computes each line's net with the OLD multiply-then-round convention —
 * the exact value the QB sync produces for these rows TODAY — and writes it to
 * the new column. This is a DB-only freeze: it does NOT contact QuickBooks and
 * does NOT re-sync anything. Old invoices in QB are untouched; we only record
 * their current value so the sync can honor it verbatim from now on.
 *
 * Legacy formula (must mirror the pre-flip invoiceLineDiscountCents):
 *   no discount      → net = total
 *   percent          → net = total − round(total × value / 100)
 *   fixed (per unit) → net = total − min(total, round(value × 100) × quantity)
 *
 * Idempotent: only touches rows where net_total_cents IS NULL.
 *
 *   yarn medusa exec src/scripts/migrations/backfill-invoice-net-totals.ts
 *   yarn medusa exec src/scripts/migrations/backfill-invoice-net-totals.ts --apply
 *
 * Defaults to DRY-RUN. Pass --apply (or APPLY=1) to write. Run in the sandbox
 * first; verify the printed reconciliation before touching prod.
 */

import { Client } from "pg";

type Row = {
  id: string;
  total: string | null;
  quantity: number | null;
  discount_type: string | null;
  discount_value: string | null;
};

/** OLD multiply-then-round net in cents — the value these rows are billed at today. */
function legacyNetCents(row: Row): number {
  const totalCents = Math.round(Number(row.total ?? 0));
  const value = Number(row.discount_value ?? 0);
  if (!row.discount_type || !Number.isFinite(value) || value <= 0) {
    return totalCents;
  }
  if (row.discount_type === "percent") {
    const discount = Math.min(totalCents, Math.round((totalCents * value) / 100));
    return Math.max(0, totalCents - discount);
  }
  if (row.discount_type === "fixed") {
    const qty = Number(row.quantity ?? 0);
    const discount = Math.min(totalCents, Math.round(value * 100) * qty);
    return Math.max(0, totalCents - discount);
  }
  return totalCents;
}

export default async function backfillInvoiceNetTotals() {
  const apply = process.argv.includes("--apply") || process.env.APPLY === "1";
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  console.log(
    `[backfill-invoice-net-totals] mode=${apply ? "APPLY" : "DRY-RUN"} db=${dbUrl.replace(/:[^:@]+@/, ":***@")}`
  );

  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    const { rows } = await client.query<Row>(
      `SELECT id, total, quantity, discount_type, discount_value
         FROM pos_invoice_item
        WHERE net_total_cents IS NULL
          AND deleted_at IS NULL`
    );

    let withDiscount = 0;
    let anomalies = 0;
    const ids: string[] = [];
    const nets: number[] = [];
    const rawNets: string[] = [];
    const samples: string[] = [];

    for (const r of rows) {
      const totalCents = Math.round(Number(r.total ?? 0));
      const net = legacyNetCents(r);
      // Invariant: a frozen net can never exceed gross or go negative.
      if (net < 0 || net > totalCents) {
        anomalies++;
        console.warn(
          `[anomaly] item ${r.id}: net=${net} total=${totalCents} type=${r.discount_type} value=${r.discount_value} — SKIPPED`
        );
        continue;
      }
      if (r.discount_type && Number(r.discount_value ?? 0) > 0) {
        withDiscount++;
        if (samples.length < 8) {
          samples.push(
            `  ${r.id}: total=${totalCents} ${r.discount_type}/${r.discount_value} → net=${net}`
          );
        }
      }
      ids.push(r.id);
      nets.push(net);
      rawNets.push(JSON.stringify({ value: net }));
    }

    console.log(
      `candidates=${rows.length}  with_line_discount=${withDiscount}  anomalies=${anomalies}  to_write=${ids.length}`
    );
    if (samples.length > 0) {
      console.log("sample discounted lines (frozen at current value):");
      console.log(samples.join("\n"));
    }

    if (!apply) {
      console.log("DRY-RUN — no rows written. Re-run with --apply to persist.");
      return;
    }
    if (ids.length === 0) {
      console.log("Nothing to write.");
      return;
    }

    const result = await client.query(
      `UPDATE pos_invoice_item AS t
          SET net_total_cents     = u.net::numeric,
              raw_net_total_cents = u.raw_net::jsonb,
              updated_at          = NOW()
         FROM UNNEST($1::text[], $2::numeric[], $3::text[])
                AS u(id, net, raw_net)
        WHERE t.id = u.id
          AND t.net_total_cents IS NULL`,
      [ids, nets, rawNets]
    );

    console.log(`APPLIED — updated=${result.rowCount ?? 0}`);
  } finally {
    await client.end();
  }
}

// Direct invocation for one-off ops in a shell.
if (require.main === module) {
  backfillInvoiceNetTotals()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[backfill-invoice-net-totals] fatal", err);
      process.exit(1);
    });
}
