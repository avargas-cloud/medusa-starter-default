/**
 * amend-partial-qb-payment — cierra el rojo (n2) de `verify-qb-sales-backfill`:
 * un ReceivePayment de QB que el POS ya tenía ANTES del backfill, pero con un
 * monto parcial (el pago cubría una factura viva del POS y otra que en ese
 * momento sólo existía en QB). La factura de QB entró por el backfill como
 * `paid` (IsPaid) pero sin `payment_application`, porque el pago se clasificó
 * como "conocido" y se saltó.
 *
 * Corrige el pago EXISTENTE (mismo TxnID, un solo pago = un ReceivePayment):
 *   - `customer_payment.amount` → total de QB (columna + raw, vía servicio)
 *   - `payment_application` nueva por la parte que faltaba, a la factura del backfill
 *   - metadata: `invoices_affected*` + marcador `qb_backfill_amend`
 *
 * Idempotente: si la aplicación ya existe, no hace nada. Nunca toca stock ni QB.
 *
 *   Dry-run:  PAYMENT_ID=cpay_… INVOICE_NUMBER=01168 QB_TOTAL_CENTS=110980 QB_TXN_ID=1C03D9-… \
 *             RUN_ID=qbsb-prod-20260912 … medusa exec ./src/scripts/fix/amend-partial-qb-payment.ts
 *   Aplicar:  + APPLY=true (sandbox) · producción: TARGET_PRODUCTION=1 ECOPOWERTECH_ENV=production
 *             CONFIRM_PRODUCTION_RUN=<RUN_ID> y el dry-run previo del mismo RUN_ID (target-guard).
 */
import { existsSync, mkdirSync, writeFileSync } from "fs";

import type { ExecArgs, Logger } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import { getDbPool } from "../../api/utils/db-pool";
import { assertDryRunEvidence, readJsonFile, resolveWriteTarget } from "../../lib/qb-backfill/target-guard";
import { FINANCE_MODULE } from "../../modules/finance";

const APPLY = process.env.APPLY === "true";
const RUN_ID = process.env.RUN_ID ?? "qbsb-20260911";
const TAG = "amend-partial-qb-payment";
const PAYMENT_ID = process.env.PAYMENT_ID ?? "";
const INVOICE_NUMBER = process.env.INVOICE_NUMBER ?? "";
const QB_TOTAL_CENTS = Number(process.env.QB_TOTAL_CENTS ?? NaN);
const QB_TXN_ID = process.env.QB_TXN_ID ?? "";
const DRY_RUN_REPORT = `.qb-docs-cache/${TAG}_${RUN_ID}-dryrun.json`;

type PaymentRow = { id: string; display_id: number; amount: string; status: string; qb_txn_id: string | null; applied: string };
type InvoiceRow = { id: string; order_id: string | null; total: string; amount_paid: string; status: string; apps: string };

interface FinanceService {
  updateCustomerPayments(data: { id: string; amount: number; metadata: Record<string, unknown> }): Promise<unknown>;
  createPaymentApplications(data: Record<string, unknown>): Promise<unknown>;
}

function fail(msg: string): never {
  throw new Error(`[${TAG}] ${msg}`);
}

export default async function amendPartialQbPayment({ container }: ExecArgs) {
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER);
  if (!PAYMENT_ID || !INVOICE_NUMBER || !QB_TXN_ID || !Number.isFinite(QB_TOTAL_CENTS)) {
    fail("faltan PAYMENT_ID, INVOICE_NUMBER, QB_TXN_ID o QB_TOTAL_CENTS");
  }
  if (APPLY) {
    const target = resolveWriteTarget({ argv: process.argv, env: process.env, databaseUrl: process.env.DATABASE_URL, runId: RUN_ID });
    logger.info(`[${TAG}] destino: ${target.target} (${target.reason})`);
    const dry = existsSync(DRY_RUN_REPORT) ? readJsonFile<Record<string, number | string>>(DRY_RUN_REPORT) : null;
    assertDryRunEvidence(target.target, RUN_ID, dry ? { path: DRY_RUN_REPORT, cardinality: dry } : null, (l) => logger.info(l));
  }

  const pool = getDbPool();
  const pay = (
    await pool.query<PaymentRow>(
      `SELECT cp.id, cp.display_id, cp.amount::text, cp.status, cp.metadata->>'qb_txn_id' AS qb_txn_id,
              COALESCE((SELECT sum(pa.amount_applied) FROM payment_application pa
                         WHERE pa.payment_id = cp.id AND pa.deleted_at IS NULL AND pa.voided_at IS NULL), 0)::text AS applied
         FROM customer_payment cp WHERE cp.id = $1 AND cp.deleted_at IS NULL`,
      [PAYMENT_ID]
    )
  ).rows[0];
  if (!pay) fail(`pago ${PAYMENT_ID} no existe`);
  if (pay.qb_txn_id !== QB_TXN_ID) fail(`el pago ${PAYMENT_ID} tiene qb_txn_id=${pay.qb_txn_id}, no ${QB_TXN_ID}`);

  const inv = (
    await pool.query<InvoiceRow>(
      `SELECT i.id, i.order_id, i.total::text, i.amount_paid::text, i.status,
              COALESCE((SELECT sum(pa.amount_applied) FROM payment_application pa
                         WHERE pa.invoice_id = i.id AND pa.deleted_at IS NULL AND pa.voided_at IS NULL), 0)::text AS apps
         FROM pos_invoice i WHERE i.invoice_number = $1 AND i.deleted_at IS NULL
          AND i.metadata->'qb_backfill'->>'run_id' = $2`,
      [INVOICE_NUMBER, RUN_ID]
    )
  ).rows[0];
  if (!inv) fail(`factura ${INVOICE_NUMBER} del run ${RUN_ID} no existe`);

  const already = Number(pay.applied);
  const missing = QB_TOTAL_CENTS - already;
  const plan = {
    payment: `PAY-${pay.display_id}`,
    amount_before: Number(pay.amount),
    amount_after: QB_TOTAL_CENTS,
    applied_before: already,
    application_to_add: missing,
    invoice: INVOICE_NUMBER,
    invoice_total: Number(inv.total),
    invoice_applied_before: Number(inv.apps),
  };
  logger.info(`[${TAG}] ${APPLY ? "APPLY" : "DRY-RUN"} · ${JSON.stringify(plan)}`);

  if (Number(inv.apps) > 0) {
    logger.info(`[${TAG}] la factura ya tiene aplicaciones (${inv.apps}¢) — nada que hacer`);
    return;
  }
  if (missing <= 0) fail(`nada que agregar: aplicado ${already}¢ ≥ total QB ${QB_TOTAL_CENTS}¢`);
  if (missing !== Number(inv.total)) fail(`la parte faltante (${missing}¢) no es el total de la factura (${inv.total}¢) — revisar a mano`);

  if (!APPLY) {
    mkdirSync(".qb-docs-cache", { recursive: true });
    writeFileSync(DRY_RUN_REPORT, JSON.stringify({ run_id: RUN_ID, ...plan }, null, 2));
    logger.info(`[${TAG}] reporte: ${DRY_RUN_REPORT} · para aplicar: APPLY=true`);
    return;
  }

  const finance = container.resolve(FINANCE_MODULE) as unknown as FinanceService;
  const meta = (await pool.query<{ metadata: Record<string, unknown> | null }>(`SELECT metadata FROM customer_payment WHERE id = $1`, [PAYMENT_ID])).rows[0]!.metadata ?? {};
  const affected = Array.isArray(meta.invoices_affected) ? (meta.invoices_affected as string[]) : [];
  const affectedFriendly = Array.isArray(meta.invoices_affected_friendly) ? (meta.invoices_affected_friendly as string[]) : [];
  await finance.updateCustomerPayments({
    id: PAYMENT_ID,
    amount: QB_TOTAL_CENTS,
    metadata: {
      ...meta,
      invoices_affected: [...affected, inv.id],
      invoices_affected_friendly: [...affectedFriendly, `INV-${INVOICE_NUMBER}`],
      qb_backfill_amend: { run_id: RUN_ID, amended_at: new Date().toISOString(), amount_before: plan.amount_before, added_application_cents: missing },
    },
  });
  await finance.createPaymentApplications({
    payment_id: PAYMENT_ID,
    invoice_id: inv.id,
    invoice_number: INVOICE_NUMBER,
    order_id: inv.order_id,
    amount_applied: missing,
    applied_at: new Date(),
    applied_by: "qb-backfill",
    metadata: { qb_backfill_amend: { run_id: RUN_ID }, qb_invoice_txn_id: QB_TXN_ID },
  });
  const after = (
    await pool.query<{ amount: string; applied: string }>(
      `SELECT cp.amount::text, (SELECT sum(pa.amount_applied) FROM payment_application pa WHERE pa.payment_id = cp.id AND pa.deleted_at IS NULL AND pa.voided_at IS NULL)::text AS applied
         FROM customer_payment cp WHERE cp.id = $1`,
      [PAYMENT_ID]
    )
  ).rows[0]!;
  logger.info(`[${TAG}] APLICADO · ${plan.payment}: amount ${after.amount}¢ · aplicado ${after.applied}¢ (esperado ${QB_TOTAL_CENTS}¢ / ${QB_TOTAL_CENTS}¢)`);
  if (Number(after.amount) !== QB_TOTAL_CENTS || Number(after.applied) !== QB_TOTAL_CENTS) fail("verificación post-write falló");
}
