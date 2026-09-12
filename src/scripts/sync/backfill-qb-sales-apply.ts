/**
 * backfill-qb-sales-apply — plan `qb-sales-backfill-20260911`, fase APPLY.
 *
 * Corre bajo `medusa exec` (necesita los module services del container):
 *
 *   env APPLY=true RUN_ID=qbsb-xxx ECOPOWERTECH_ENV=sandbox DATABASE_URL=… \
 *       DISABLE_SCHEDULED_JOBS=true QB_BRIDGE_DISABLED=true \
 *       CLASSIFICATION=.qb-docs-cache/sales-classification_<run>.json \
 *       [TYPES=invoice,sales_receipt,receive_payment,credit_memo[,credit_application]] [LIMIT=N] \
 *     ./node_modules/.bin/medusa exec ./src/scripts/sync/backfill-qb-sales-apply.ts
 *
 *   ROLLBACK=true RUN_ID=qbsb-xxx …  → borra todo lo marcado con ese run_id.
 *
 *   `TYPES=credit_application` (sólo si se pide): aplicaciones CM→factura desde
 *   los `pos_credit_memo` del run YA en la DB (`metadata.qb_linked_txns`), no
 *   desde la clasificación — `lib/qb-backfill/apply-sales-credit-links.ts`.
 *
 * Guards: sin `APPLY=true` es dry-run (cuenta, no escribe); se NIEGA a correr
 * si `ECOPOWERTECH_ENV !== 'sandbox'` (este plan todavía no tiene R3 para
 * producción). `DISABLE_SCHEDULED_JOBS=true` no es opcional: sin él
 * `medusa exec` levanta los crons del pipeline de QuickBooks.
 *
 * Escrituras: module services (orden, factura, pago, credit memo) + SQL crudo
 * transaccional por documento (`lib/qb-backfill/apply-sales.ts`). Nunca
 * encola nada despachable; nunca toca stock ni reservas.
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { Pool } from "pg";
import type { ExecArgs, Logger } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";

import { INVOICE_MODULE } from "../../modules/invoices";
import { FINANCE_MODULE } from "../../modules/finance";
import { CREDIT_MEMO_MODULE } from "../../modules/credit_memos";
import { applySales, rollbackSales, type SalesApplyReport, type SalesApplyType, type SalesClassification } from "../../lib/qb-backfill/apply-sales";
import { POS_GO_LIVE_DATE } from "../../lib/qb-backfill/create-po";
import { newEnsureLog } from "../../lib/qb-backfill/ensure";
import { loadItemIndex } from "../../lib/qb-backfill/resolve";
import { loadCustomerIndex, makeEnsureCustomer, type SalesApplyContext, type SalesServices } from "../../lib/qb-backfill/sales-context";

const APPLY = process.env.APPLY === "true";
const ROLLBACK = process.env.ROLLBACK === "true";
const RUN_ID = process.env.RUN_ID ?? "";
const CLASSIFICATION = process.env.CLASSIFICATION ?? "";
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : undefined;
const TYPES = (process.env.TYPES ?? "invoice,sales_receipt,receive_payment,credit_memo")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean) as SalesApplyType[];

function summarize(report: SalesApplyReport): string[] {
  const line = (label: string, t: SalesApplyReport["invoices"]) =>
    `  ${label.padEnd(16)} already=${t.already} create=${t.create} created=${t.created.length} blocked=${t.blocked.length}`;
  return [
    line("invoices", report.invoices),
    line("sales_receipts", report.sales_receipts),
    line("receive_payments", report.receive_payments),
    line("credit_memos", report.credit_memos),
    line("credit_applic.", report.credit_applications) +
      ` payments_created=${report.credit_applications.payments_created} applications_created=${report.credit_applications.applications_created} unlinked_credit_link=${report.unlinked_credit_link.length}`,
    `  unlinked_application=${report.unlinked_application.length} discount_ignored=${report.discount_ignored.length} set_credit_ignored=${report.set_credit_ignored.length} total_mismatch=${report.total_mismatch.length}`,
  ];
}

export default async function backfillQbSalesApply({ container }: ExecArgs): Promise<void> {
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER);
  const log = (s: string) => logger.info(s);

  if (process.env.ECOPOWERTECH_ENV !== "sandbox") {
    throw new Error("backfill-qb-sales-apply: sólo corre con ECOPOWERTECH_ENV=sandbox (sin R3 para producción)");
  }
  if (!RUN_ID) throw new Error("RUN_ID es obligatorio");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL es obligatorio");

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const services: SalesServices = {
    orderModule: container.resolve(Modules.ORDER) as unknown as SalesServices["orderModule"],
    invoiceService: container.resolve(INVOICE_MODULE) as unknown as SalesServices["invoiceService"],
    financeService: container.resolve(FINANCE_MODULE) as unknown as SalesServices["financeService"],
    creditMemoService: container.resolve(CREDIT_MEMO_MODULE) as unknown as SalesServices["creditMemoService"],
  };

  try {
    if (ROLLBACK) {
      log(`ROLLBACK run_id=${RUN_ID}`);
      const counts = await rollbackSales(client, RUN_ID, { services });
      log(JSON.stringify(counts));
      return;
    }

    if (!CLASSIFICATION || !existsSync(CLASSIFICATION)) {
      throw new Error(`CLASSIFICATION no existe: ${CLASSIFICATION || "(vacío)"}`);
    }
    // El driver de clasificación (`backfill-qb-sales.ts`) escribe la clave `payments`;
    // el orquestador la llama `receive_payments` (el tipo del bucket). Se aceptan las dos.
    const raw = JSON.parse(readFileSync(CLASSIFICATION, "utf8")) as Record<string, unknown>;
    if (!raw.receive_payments && raw.payments) raw.receive_payments = raw.payments;
    const classification = raw as unknown as SalesClassification;
    for (const k of ["invoices", "sales_receipts", "receive_payments", "credit_memos"] as const) {
      if (!Array.isArray(classification[k]?.create)) throw new Error(`CLASSIFICATION: falta ${k}.create[]`);
    }

    const region = await client.query(`SELECT id FROM region WHERE deleted_at IS NULL AND currency_code = 'usd' ORDER BY created_at LIMIT 1`);
    const channel = await client.query(
      `SELECT id FROM sales_channel WHERE deleted_at IS NULL ORDER BY (name = 'POS') DESC, created_at LIMIT 1`
    );
    const regionId = region.rows[0]?.id as string | undefined;
    const salesChannelId = channel.rows[0]?.id as string | undefined;
    if (!regionId || !salesChannelId) throw new Error("sin region usd / sales_channel — no se puede crear órdenes");

    const itemIndex = await loadItemIndex(client);
    const customerIndex = await loadCustomerIndex(client);
    const ensureLog = newEnsureLog();
    const customersCreated: Array<{ qb_list_id: string; full_name: string; id: string }> = [];
    const ctx: SalesApplyContext = {
      client,
      services,
      runId: RUN_ID,
      itemIndex,
      customerIndex,
      ensureCustomer: makeEnsureCustomer(client, customerIndex, RUN_ID, (ref, id) =>
        customersCreated.push({ qb_list_id: ref.list_id, full_name: ref.full_name, id })
      ),
      ensureLog,
      log,
      regionId,
      salesChannelId,
      goLiveDate: POS_GO_LIVE_DATE,
    };

    log(
      `${APPLY ? "APPLY" : "DRY-RUN"} run_id=${RUN_ID} types=${TYPES.join(",")}${LIMIT !== undefined ? ` limit=${LIMIT}` : ""} · ` +
        `clasificación: inv=${classification.invoices.create.length} sr=${classification.sales_receipts.create.length} ` +
        `pay=${classification.receive_payments.create.length} cm=${classification.credit_memos.create.length} · ` +
        `índices: ${itemIndex.byQbId.size + itemIndex.bySku.size} ítems, ${customerIndex.size} clientes`
    );
    const report = await applySales(classification, ctx, { apply: APPLY, limit: LIMIT, types: TYPES });
    for (const l of summarize(report)) log(l);
    if (ensureLog.items_created.length) log(`  ítems creados (descontinuados): ${ensureLog.items_created.map((i) => i.sku).join(", ")}`);
    if (customersCreated.length) log(`  clientes creados: ${customersCreated.map((c) => c.full_name).join(", ")}`);

    const out = process.env.REPORT_OUT ?? `.qb-docs-cache/sales-apply_${RUN_ID}${APPLY ? "" : "-dryrun"}.json`;
    writeFileSync(out, JSON.stringify({ run_id: RUN_ID, apply: APPLY, types: TYPES, limit: LIMIT ?? null, report, ensureLog, customersCreated }, null, 2));
    log(`  reporte: ${out}`);
  } finally {
    client.release();
    await pool.end();
  }
}
