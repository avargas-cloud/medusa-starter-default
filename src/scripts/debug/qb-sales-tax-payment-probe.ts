/**
 * qb-sales-tax-payment-probe — sonda controlada del SalesTaxPaymentCheckAdd de
 * dos líneas contra QuickBooks REAL (plan sales-tax-center-20260917, checkpoint
 * R3 aprobado por el operador el 09/17/2026).
 *
 *   --create   crea STA (allowance $0.30) + STP (tax $1.30 − 0.30 = $1.00) en el
 *              período dado y encola los dos ADD; los crons de prod despachan.
 *   --status   muestra los docs de la sonda y sus filas del pipeline.
 *   --void     anula STP y STA (reversa GL + TxnVoid encolado).
 *
 *   env DATABASE_URL=<prod> DISABLE_SCHEDULED_JOBS=true \
 *     ./node_modules/.bin/tsx src/scripts/debug/qb-sales-tax-payment-probe.ts --create [--period 2026-08]
 *
 * Los montos son deliberadamente ridículos y el memo/reference dicen PROBE para
 * que nadie los confunda con un pago. NO marca la declaración como filed.
 */
import { getDbPool } from "../../api/utils/db-pool";
import { createSalesTaxAdjustment, voidSalesTaxAdjustment } from "../../lib/ledger/documents/sales-tax-adjustment";
import { createSalesTaxPayment, voidSalesTaxPayment } from "../../lib/ledger/documents/sales-tax-payment";
import { loadSalesTaxSettings } from "../../lib/sales-tax/settings";

const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : null;
};
const PERIOD = flag("--period") ?? "2026-08";
const DAY = flag("--day") ?? new Date().toISOString().slice(0, 10);
const REF = "PROBE-STC";
const log = (s: string): void => process.stdout.write(`${s}\n`);

async function main(): Promise<void> {
  if (process.env.DISABLE_SCHEDULED_JOBS !== "true") throw new Error("DISABLE_SCHEDULED_JOBS=true es obligatorio (no levantar un segundo despachador)");
  const pool = getDbPool();
  const client = await pool.connect();
  try {
    const actor = (await client.query<{ id: string }>(`SELECT id FROM "user" WHERE lower(email)='a.vargas@ecopowertech.com' AND deleted_at IS NULL`)).rows[0];
    if (!actor) throw new Error("actor no encontrado");
    const settings = await loadSalesTaxSettings(client);
    if (!settings.ready) throw new Error(`settings incompletos: ${settings.missing.join(", ")}`);

    if (argv.includes("--create")) {
      const adj = await createSalesTaxAdjustment(
        client,
        {
          period: PERIOD, day: DAY, type: "collection_allowance", amount_cents: 30n,
          payable_list_id: settings.accounts.payable_list_id,
          offset_account_list_id: settings.accounts.adjustment_income_list_id!,
          vendor_list_id: settings.vendor_list_id, vendor_name: settings.vendor_name,
          reason: "PROBE sales-tax-center-20260917 — void after readback",
        },
        actor.id
      );
      log(`STA ${adj.adjustment.doc_number} ${adj.adjustment.id} · qb ${JSON.stringify(adj.post.qb)}`);
      const pay = await createSalesTaxPayment(
        client,
        {
          period: PERIOD, day: DAY, bank_account_list_id: settings.default_bank_account_list_id!,
          payable_list_id: settings.accounts.payable_list_id, vendor_list_id: settings.vendor_list_id,
          vendor_name: settings.vendor_name ?? "Sales tax agency", tax_item_list_id: settings.tax_item_list_id,
          tax_item_name: settings.tax_item_name, tax_cents: 130n, adjustment_ids: [adj.adjustment.id],
          reference: REF, memo: "PROBE sales-tax-center-20260917 — void after readback",
        },
        actor.id
      );
      log(`STP ${pay.payment.doc_number} ${pay.payment.id} · total ${pay.payment.total_cents} · qb ${JSON.stringify(pay.post.qb)}`);
      return;
    }

    const docs = await client.query<{ kind: string; id: string; doc_number: string; status: string; qb_txn_id: string | null; total: string }>(
      `SELECT 'STP' AS kind, id, doc_number, status, qb_txn_id, total_cents::text AS total FROM gl_sales_tax_payment WHERE reference = $1 AND deleted_at IS NULL
       UNION ALL SELECT 'STA', id, doc_number, status, qb_txn_id, amount_cents::text FROM gl_sales_tax_adjustment WHERE reason LIKE 'PROBE%' AND deleted_at IS NULL
       ORDER BY 1 DESC`,
      [REF]
    );
    for (const d of docs.rows) {
      const rows = await client.query<{ step: string; status: string; qb_txn_id: string | null; error: string | null }>(
        `SELECT step, status, qb_txn_id, error FROM qb_order_pipeline WHERE reference_id = $1 ORDER BY created_at`,
        [d.id]
      );
      log(`${d.kind} ${d.doc_number} ${d.status} qb=${d.qb_txn_id ?? "-"} amount=${d.total} · pipeline: ${rows.rows.map((r) => `${r.step}:${r.status}${r.qb_txn_id ? `(${r.qb_txn_id})` : ""}${r.error ? ` ERR ${r.error.slice(0, 120)}` : ""}`).join(" | ")}`);
    }
    if (argv.includes("--void")) {
      for (const d of docs.rows.filter((x) => x.status === "posted")) {
        if (d.kind === "STP") log(`void STP → ${(await voidSalesTaxPayment(client, d.id, "PROBE void after readback", actor.id)).status}`);
      }
      for (const d of docs.rows.filter((x) => x.status === "posted")) {
        if (d.kind === "STA") log(`void STA → ${(await voidSalesTaxAdjustment(client, d.id, "PROBE void after readback", actor.id)).status}`);
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
