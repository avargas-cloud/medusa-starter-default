/**
 * src/lib/qb-backfill/apply-sales.ts
 *
 * Orquestación del apply de VENTAS (plan 2): recorre la clasificación en
 * orden de dependencia — invoices → sales receipts → receive payments →
 * credit memos → aplicaciones de credit memos a facturas (`credit_application`,
 * leídas de la DB por marcador, no de la clasificación) — con una transacción `BEGIN/COMMIT` por documento sobre
 * `ctx.client` (SQL crudo: numeración, pipeline, backdateo, ensure*). Los
 * module services escriben por su propia conexión, así que un fallo a mitad
 * de documento hace ROLLBACK de lo transaccional Y limpia por marcador
 * (`run_id` + `txn_id`) lo que el service ya había commiteado; el documento
 * queda `blocked` con el error y el loop sigue.
 *
 * Idempotencia: por TxnID contra `loadKnownSalesTxnIds` (releído por tipo,
 * así una corrida repetida cuenta `already` y no duplica).
 *
 * `rollbackSales(client, runId)`: borra en orden inverso todo lo marcado con
 * ese `run_id`. Se NIEGA si alguna `payment_application` ajena al run apunta a
 * una factura o a un pago del run — alguien ya trabajó sobre esos documentos.
 */
import type { QueryableDb } from "./resolve";
import type { DocOutcome, TypeApplyReport } from "./apply-purchases";
import { createInvoiceFromQb } from "./create-sales-invoice";
import { createSalesReceiptFromQb } from "./create-sales-receipt";
import { createReceivePaymentFromQb, newPaymentNotes, type PaymentNotes } from "./create-sales-payment";
import { createCreditMemoFromQb } from "./create-sales-credit-memo";
import {
  applyCreditMemoApplications,
  loadBackfilledCreditMemos,
  planCreditMemoApplications,
  type CreditApplicationsReport,
  type UnlinkedCreditLink,
} from "./apply-sales-credit-links";
import { loadKnownSalesTxnIds, type SalesApplyContext, type SalesServices } from "./sales-context";
import type { QbCreditMemo, QbInvoice, QbReceivePayment, QbSalesDocType, QbSalesReceipt } from "./sales-types";

export interface SalesClassification {
  invoices: { create: QbInvoice[] };
  sales_receipts: { create: QbSalesReceipt[] };
  receive_payments: { create: QbReceivePayment[] };
  credit_memos: { create: QbCreditMemo[] };
}

export interface TotalMismatch {
  txn_id: string;
  doc_type: QbSalesDocType;
  computed_cents: number;
  expected_cents: number;
}

export interface SalesApplyReport extends PaymentNotes {
  invoices: TypeApplyReport;
  sales_receipts: TypeApplyReport;
  receive_payments: TypeApplyReport;
  credit_memos: TypeApplyReport;
  /** Fase `credit_application`: un "documento" = un CM con ≥1 aplicación planeada. */
  credit_applications: CreditApplicationsReport;
  /** Enlaces CM→Invoice cuya factura el POS no conoce (no bloquean). */
  unlinked_credit_link: UnlinkedCreditLink[];
  total_mismatch: TotalMismatch[];
}

/** Los 4 tipos de documento + la fase derivada `credit_application` (no es un documento de QB). */
export type SalesApplyType = QbSalesDocType | "credit_application";

export interface SalesApplyOptions {
  apply: boolean;
  limit?: number;
  types?: readonly SalesApplyType[];
}

function newTypeReport(): TypeApplyReport {
  return { already: 0, create: 0, created: [], blocked: [] };
}

type CreateFn<T> = (ctx: SalesApplyContext, doc: T) => Promise<{ ok: true; id: string } | { ok: false; reason: string; detail?: Record<string, unknown> }>;

async function applyType<T extends { txn_id: string }>(
  ctx: SalesApplyContext,
  docTypeOf: QbSalesDocType | ((doc: T) => QbSalesDocType),
  docs: readonly T[],
  known: ReadonlySet<string>,
  create: CreateFn<T>,
  opts: SalesApplyOptions,
  report: SalesApplyReport,
  /** Reporte por documento — permite MEZCLAR tipos en un solo recorrido cronológico. */
  reportOf?: (doc: T) => TypeApplyReport
): Promise<TypeApplyReport> {
  const fallbackReport = newTypeReport();
  let planned = 0;
  for (const doc of docs) {
    const docType = typeof docTypeOf === "function" ? docTypeOf(doc) : docTypeOf;
    const typeReport = reportOf ? reportOf(doc) : fallbackReport;
    if (known.has(doc.txn_id)) { typeReport.already++; continue; }
    // `continue`, no `break`: el recorrido ya no es por tipo sino cronológico, y
    // el conteo de `already` no debe depender de dónde caiga el tope.
    if (opts.limit !== undefined && planned >= opts.limit) continue;
    planned++;
    typeReport.create++;
    if (!opts.apply) continue;
    try {
      await ctx.client.query("BEGIN");
      const result = await create(ctx, doc);
      if (!result.ok) {
        await ctx.client.query("ROLLBACK");
        await cleanupDocument(ctx.client, ctx.services, ctx.runId, doc.txn_id);
        const outcome: DocOutcome = { txn_id: doc.txn_id, blocked_reason: result.reason };
        typeReport.blocked.push(outcome);
        if (result.reason === "total_mismatch" && result.detail) {
          report.total_mismatch.push({
            txn_id: doc.txn_id,
            doc_type: docType,
            computed_cents: Number(result.detail.computed_cents),
            expected_cents: Number(result.detail.expected_cents),
          });
        }
        ctx.log(`  [${docType}] ${doc.txn_id} BLOQUEADO: ${result.reason}${result.detail ? " " + JSON.stringify(result.detail).slice(0, 300) : ""}`);
        continue;
      }
      await ctx.client.query("COMMIT");
      typeReport.created.push({ txn_id: doc.txn_id, created: result.id });
      ctx.log(`  [${docType}] ${doc.txn_id} → ${result.id}`);
    } catch (err) {
      await ctx.client.query("ROLLBACK").catch(() => undefined);
      await cleanupDocument(ctx.client, ctx.services, ctx.runId, doc.txn_id).catch((e: Error) => ctx.log(`  cleanup ${doc.txn_id} falló: ${e.message}`));
      typeReport.blocked.push({ txn_id: doc.txn_id, blocked_reason: (err as Error).message });
      ctx.log(`  [${docType}] ${doc.txn_id} ERROR: ${(err as Error).message}`);
    }
  }
  return fallbackReport;
}

/** Invoices y sales receipts comparten la numeración histórica (S0001.., 00001..):
 *  se crean en UN recorrido ordenado por (txn_date, txn_id) para que el número
 *  siga la cronología real, como los PO-0001.. del plan de compras. */
type MergedSalesDoc =
  | { txn_id: string; txn_date: string; kind: "invoice"; doc: QbInvoice }
  | { txn_id: string; txn_date: string; kind: "sales_receipt"; doc: QbSalesReceipt };

function mergeChronologically(invoices: readonly QbInvoice[], receipts: readonly QbSalesReceipt[]): MergedSalesDoc[] {
  const merged: MergedSalesDoc[] = [
    ...invoices.map((doc) => ({ txn_id: doc.txn_id, txn_date: doc.txn_date, kind: "invoice" as const, doc })),
    ...receipts.map((doc) => ({ txn_id: doc.txn_id, txn_date: doc.txn_date, kind: "sales_receipt" as const, doc })),
  ];
  return merged.sort((a, b) => (a.txn_date < b.txn_date ? -1 : a.txn_date > b.txn_date ? 1 : a.txn_id < b.txn_id ? -1 : a.txn_id > b.txn_id ? 1 : 0));
}

export async function applySales(classification: SalesClassification, ctx: SalesApplyContext, opts: SalesApplyOptions): Promise<SalesApplyReport> {
  const types = new Set<SalesApplyType>(opts.types ?? ["invoice", "sales_receipt", "receive_payment", "credit_memo"]);
  const report: SalesApplyReport = {
    invoices: newTypeReport(),
    sales_receipts: newTypeReport(),
    receive_payments: newTypeReport(),
    credit_memos: newTypeReport(),
    credit_applications: { ...newTypeReport(), payments_created: 0, applications_created: 0 },
    unlinked_credit_link: [],
    total_mismatch: [],
    ...newPaymentNotes(),
  };
  const notes: PaymentNotes = report;

  if (types.has("invoice") || types.has("sales_receipt")) {
    const knownAll = await loadKnownSalesTxnIds(ctx.client);
    const known = new Set<string>([...knownAll.invoices, ...knownAll.sales_receipts]);
    const merged = mergeChronologically(
      types.has("invoice") ? classification.invoices.create : [],
      types.has("sales_receipt") ? classification.sales_receipts.create : []
    );
    await applyType<MergedSalesDoc>(
      ctx,
      (m) => m.kind,
      merged,
      known,
      async (c, m) => {
        if (m.kind === "invoice") {
          const r = await createInvoiceFromQb(c, m.doc);
          return r.ok ? { ok: true, id: `${r.ids.document_number}/INV-${r.ids.invoice_number}` } : r;
        }
        const r = await createSalesReceiptFromQb(c, m.doc);
        return r.ok ? { ok: true, id: `${r.ids.document_number}/SR-${r.ids.invoice_number}` } : r;
      },
      opts,
      report,
      (m) => (m.kind === "invoice" ? report.invoices : report.sales_receipts)
    );
  }
  if (types.has("receive_payment")) {
    const known = (await loadKnownSalesTxnIds(ctx.client)).receive_payments;
    report.receive_payments = await applyType(ctx, "receive_payment", classification.receive_payments.create, known, async (c, d) => {
      const r = await createReceivePaymentFromQb(c, d, notes);
      return r.ok ? { ok: true, id: `PAY-${r.display_id} (${r.applications} aplic.)` } : r;
    }, opts, report);
  }
  if (types.has("credit_memo")) {
    const known = (await loadKnownSalesTxnIds(ctx.client)).credit_memos;
    report.credit_memos = await applyType(ctx, "credit_memo", classification.credit_memos.create, known, async (c, d) => {
      const r = await createCreditMemoFromQb(c, d);
      return r.ok ? { ok: true, id: r.credit_memo_number } : r;
    }, opts, report);
  }
  if (types.has("credit_application")) {
    // Sólo cuando se pide explícitamente: lee los CM del run desde la DB (marcador),
    // no de la clasificación — así corre también sobre CMs creados en corridas anteriores.
    const cms = await loadBackfilledCreditMemos(ctx.client, ctx.runId);
    const plan = await planCreditMemoApplications(cms, ctx.client);
    report.unlinked_credit_link = plan.unlinked;
    report.credit_applications = await applyCreditMemoApplications(ctx, cms, plan, opts.apply);
  }
  return report;
}

// ── Rollback por marcador ─────────────────────────────────────────────────

const MARK = `metadata->'qb_backfill'->>'run_id' = $1`;
const TXN = `AND ($2::text IS NULL OR metadata->'qb_backfill'->>'txn_id' = $2)`;

export interface RollbackCounts {
  payment_application: number;
  invoice_payment: number;
  customer_payment: number;
  pos_credit_memo_item: number;
  pos_credit_memo: number;
  pos_invoice_item: number;
  pos_invoice: number;
  orders: number;
  qb_order_pipeline: number;
}

export class RollbackRefused extends Error {}

/**
 * Borra (en orden inverso a la creación) todo lo marcado con `runId`; con
 * `txnId` se limita a UN documento (limpieza tras fallo). Las órdenes se
 * soft-borran por el módulo (los triggers de Meili sacan el doc); el resto es
 * hard delete, como en `rollback-qb-invoices-goodlook.ts`.
 */
export async function rollbackSales(
  client: QueryableDb,
  runId: string,
  opts: { services?: Pick<SalesServices, "orderModule">; txnId?: string | null } = {}
): Promise<RollbackCounts> {
  const txnId = opts.txnId ?? null;
  const p = [runId, txnId];
  const count = async (sql: string, params: unknown[] = p): Promise<number> => {
    const { rows } = await client.query(sql, params);
    return rows.length;
  };

  // Guard: aplicaciones AJENAS sobre facturas o pagos del run → alguien ya operó encima.
  const foreign = await client.query(
    `SELECT pa.id FROM payment_application pa
      WHERE pa.deleted_at IS NULL AND coalesce(pa.metadata->'qb_backfill'->>'run_id','') <> $1
        AND (pa.invoice_id IN (SELECT id FROM pos_invoice WHERE ${MARK} ${TXN})
          OR pa.payment_id IN (SELECT id FROM customer_payment WHERE ${MARK} ${TXN}))`,
    p
  );
  if (foreign.rows.length > 0) {
    throw new RollbackRefused(`rollback ${runId}: ${foreign.rows.length} payment_application ajena(s) sobre documentos del run (p.ej. ${String(foreign.rows[0]!.id)})`);
  }

  const counts: RollbackCounts = {
    payment_application: 0, invoice_payment: 0, customer_payment: 0, pos_credit_memo_item: 0,
    pos_credit_memo: 0, pos_invoice_item: 0, pos_invoice: 0, orders: 0, qb_order_pipeline: 0,
  };
  // Aplicaciones de CM (`apply-sales-credit-links.ts`): deshacer el backfill de
  // `pos_invoice.payment_method` que ellas mismas marcaron, y recalcular el status
  // de los pagos `credit_memo` que SOBREVIVEN (los nativos reusados, sin marcador).
  await client.query(
    `UPDATE pos_invoice SET payment_method = NULL, updated_at = now()
      WHERE id IN (SELECT invoice_id FROM payment_application WHERE ${MARK} ${TXN} AND metadata->>'set_invoice_payment_method' = 'true')`,
    p
  );
  const { rows: survivors } = await client.query(
    `SELECT DISTINCT pa.payment_id FROM payment_application pa JOIN customer_payment cp ON cp.id = pa.payment_id
      WHERE pa.metadata->'qb_backfill'->>'run_id' = $1
        AND ($2::text IS NULL OR pa.metadata->'qb_backfill'->>'txn_id' = $2)
        AND cp.type = 'credit_memo' AND coalesce(cp.metadata->'qb_backfill'->>'run_id', '') <> $1`,
    p
  );
  counts.payment_application = await count(`DELETE FROM payment_application WHERE ${MARK} ${TXN} RETURNING id`);
  for (const s of survivors) {
    await client.query(
      `UPDATE customer_payment cp SET status = CASE WHEN s.applied <= 0 THEN 'available' WHEN s.applied >= cp.amount THEN 'applied' ELSE 'partially_applied' END, updated_at = now()
         FROM (SELECT COALESCE(SUM(amount_applied), 0) AS applied FROM payment_application WHERE payment_id = $1 AND deleted_at IS NULL AND voided_at IS NULL) s
        WHERE cp.id = $1 AND cp.status IN ('available','partially_applied','applied')`,
      [String(s.payment_id)]
    );
  }
  counts.invoice_payment = await count(
    `DELETE FROM invoice_payment WHERE invoice_id IN (SELECT id FROM pos_invoice WHERE ${MARK} ${TXN}) RETURNING id`
  );
  counts.customer_payment = await count(`DELETE FROM customer_payment WHERE ${MARK} ${TXN} RETURNING id`);
  counts.pos_credit_memo_item = await count(
    `DELETE FROM pos_credit_memo_item WHERE credit_memo_id IN (SELECT id FROM pos_credit_memo WHERE ${MARK} ${TXN}) RETURNING id`
  );
  counts.pos_credit_memo = await count(`DELETE FROM pos_credit_memo WHERE ${MARK} ${TXN} RETURNING id`);
  counts.pos_invoice_item = await count(
    `DELETE FROM pos_invoice_item WHERE invoice_id IN (SELECT id FROM pos_invoice WHERE ${MARK} ${TXN}) RETURNING id`
  );
  counts.pos_invoice = await count(`DELETE FROM pos_invoice WHERE ${MARK} ${TXN} RETURNING id`);

  const { rows: orders } = await client.query(`SELECT id FROM "order" WHERE deleted_at IS NULL AND ${MARK} ${TXN}`, p);
  const orderIds = orders.map((r) => String(r.id));
  if (orderIds.length > 0) {
    if (opts.services) {
      await opts.services.orderModule.softDeleteOrders(orderIds);
    } else {
      await client.query(`UPDATE "order" SET deleted_at = now(), updated_at = now() WHERE id = ANY($1::text[])`, [orderIds]);
      await client.query(`UPDATE order_item SET deleted_at = now(), updated_at = now() WHERE order_id = ANY($1::text[])`, [orderIds]);
      await client.query(`UPDATE order_summary SET deleted_at = now(), updated_at = now() WHERE order_id = ANY($1::text[])`, [orderIds]);
    }
  }
  counts.orders = orderIds.length;
  counts.qb_order_pipeline = await count(
    `DELETE FROM qb_order_pipeline WHERE payload->>'run_id' = $1
        AND ($2::text IS NULL OR qb_txn_id = $2 OR order_id = ANY($3::text[])) RETURNING id`,
    [runId, txnId, orderIds]
  );
  return counts;
}

/** Limpieza de UN documento tras un fallo a mitad de creación (los services ya commitearon lo suyo). */
export async function cleanupDocument(client: QueryableDb, services: SalesServices, runId: string, txnId: string): Promise<RollbackCounts> {
  return rollbackSales(client, runId, { services, txnId });
}
