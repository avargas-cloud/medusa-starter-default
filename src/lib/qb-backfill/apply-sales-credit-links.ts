/**
 * src/lib/qb-backfill/apply-sales-credit-links.ts
 *
 * Aplicaciones de Credit Memos a facturas, reconstruidas desde QuickBooks —
 * el espejo de ventas de `apply-credit-links.ts` (vendor credit → bill).
 *
 * En QB una factura "pagada" con un credit memo no tiene ReceivePayment: el CM
 * lleva `LinkedTxn TxnType=Invoice` con `Amount` NEGATIVO = lo aplicado.
 * Medido en el sandbox 2026-09-11 (run `qbsb-20260911`): 39+ facturas
 * backfilleadas `paid` sin ninguna `payment_application`.
 *
 * Forma nativa que se espeja (leída en
 * `api/admin/pos/credit_memos/[id]/complete/route.ts` "AR LEDGER SYNC" y
 * `api/admin/finance/payments/[id]/apply/route.ts` pasos 3-4 y 6):
 *  - UN `customer_payment` por CM: `type='credit_memo'`, `method='credit_memo'`,
 *    `source='pos'`, `reference` = número del CM, `amount` = total del CM,
 *    `display_id` = `nextval('custom_payment_seq')`, `metadata.qb_txn_id` = TxnID
 *    del CM (+ `qb_sync_status: 'synced'`, lo que el consolidator deja al
 *    confirmar). Nativamente nace `available` y el apply lo pasa a
 *    `partially_applied`/`applied`; acá el status se DERIVA de Σ aplicado.
 *  - Una `payment_application` por factura: `payment_id`, `invoice_id`,
 *    `invoice_number`, `order_id`, `amount_applied`, `applied_at`, `applied_by`.
 *  - Una fila `qb_order_pipeline` `apply_payment`/`payment_application`
 *    `confirmed` por aplicación (keyeada por `papp_`, `qb_txn_id` = TxnID del
 *    CM, `medusa_ref_number` = `PAY-<display_id>`), como las 100 nativas del
 *    sandbox. El pago en sí NO tiene fila `payment` (nativo tampoco).
 *  - `pos_invoice.payment_method` se backfillea a `credit_memo` sólo si es NULL
 *    (el apply nativo hace lo mismo con el `method` del pago).
 *
 * Lo que NO se espeja, a propósito:
 *  - `pos_invoice.amount_paid/balance_due/status`: la factura backfilleada ya
 *    nació con el saldo del header de QB (que incluye esta aplicación) — igual
 *    que `create-sales-payment.ts`.
 *  - `invoice_payment` (el paso 5 nativo): el backfill de ReceivePayment
 *    tampoco lo crea; `getAppliedInvoiceTotal` prefiere `payment_application`.
 *  - inventario, `customer_credit_ledger`, GL hooks.
 *
 * Idempotente por par (CM TxnID, invoice_id) contra `payment_application` viva
 * de pagos `type='credit_memo'`; el pago se REUSA si ya existe uno con
 * `metadata.qb_txn_id` = TxnID del CM (p.ej. uno nativo). `applied_at` = la
 * fecha más tardía de los dos documentos, como en compras.
 */
import { businessInstant } from "./create-po";
import type { QueryableDb } from "./resolve";
import type { DocOutcome, TypeApplyReport } from "./apply-purchases";
import { allocatePaymentDisplayId } from "./sales-numbering";
import {
  BACKFILL_ACTOR,
  backdateRows,
  backfillMarker,
  findPosInvoiceByQbTxnId,
  firstId,
  seedPipelineRow,
  type SalesApplyContext,
} from "./sales-context";
import type { QbLinkedTxn } from "./sales-types";

/** `pos_credit_memo` del run, con los enlaces de QB que el creador guardó en `metadata.qb_linked_txns`. */
export interface BackfilledCreditMemo {
  cm_id: string;
  cm_txn_id: string;
  cm_ref_number: string | null;
  credit_memo_number: string;
  customer_id: string;
  total_cents: number;
  cm_date: string; // YYYY-MM-DD
  linked_txns: QbLinkedTxn[];
}

export interface LinkedInvoiceRef {
  invoice_id: string;
  invoice_number: string;
  order_id: string;
  invoice_date: string; // YYYY-MM-DD
}

export interface CreditMemoApplicationRow {
  cm_id: string;
  cm_txn_id: string;
  customer_id: string;
  invoice_txn_id: string;
  invoice_id: string;
  invoice_number: string;
  order_id: string;
  amount_cents: number;
  applied_at: string; // YYYY-MM-DD
}
export interface UnlinkedCreditLink {
  cm_txn_id: string;
  invoice_txn_id: string;
  invoice_ref_number: string | null;
  amount_cents: number;
}
export interface CreditMemoApplicationSkip {
  cm_txn_id: string;
  invoice_txn_id: string;
  reason: "already" | "zero_amount" | "exceeds_credit";
}
export interface CreditMemoApplicationPlan {
  rows: CreditMemoApplicationRow[];
  unlinked: UnlinkedCreditLink[];
  skipped: CreditMemoApplicationSkip[];
}

export function cmPairKey(cmTxnId: string, invoiceId: string): string {
  return `${cmTxnId}\t${invoiceId}`;
}

/** Enlaces del CM a facturas con monto negativo (= aplicado). Los `CreditMemo`/`Check`/`ARRefundCreditCard` no son aplicaciones. */
export function negativeInvoiceLinks(cm: Pick<BackfilledCreditMemo, "linked_txns">): QbLinkedTxn[] {
  return cm.linked_txns.filter((l) => l.txn_type === "Invoice" && (l.amount_cents ?? 0) < 0);
}

/**
 * Parte PURA del plan. `resolved` = factura del POS por TxnID de QB (null =
 * desconocida); `existingPairs` = `cmPairKey` de aplicaciones vivas;
 * `appliedByCm` = Σ ya aplicado por TxnID de CM (pagos reusados).
 */
export function planCreditMemoApplicationRows(
  cms: readonly BackfilledCreditMemo[],
  resolved: ReadonlyMap<string, LinkedInvoiceRef | null>,
  existingPairs: ReadonlySet<string>,
  appliedByCm: ReadonlyMap<string, number> = new Map()
): CreditMemoApplicationPlan {
  const rows: CreditMemoApplicationRow[] = [];
  const unlinked: UnlinkedCreditLink[] = [];
  const skipped: CreditMemoApplicationSkip[] = [];
  for (const cm of cms) {
    let planned = appliedByCm.get(cm.cm_txn_id) ?? 0;
    const seen = new Set<string>();
    for (const link of negativeInvoiceLinks(cm)) {
      if (seen.has(link.txn_id)) continue; // QB no repite el enlace; por las dudas
      seen.add(link.txn_id);
      const base = { cm_txn_id: cm.cm_txn_id, invoice_txn_id: link.txn_id };
      const amount = Math.abs(link.amount_cents ?? 0);
      const inv = resolved.get(link.txn_id) ?? null;
      if (!inv) {
        unlinked.push({ ...base, invoice_ref_number: link.ref_number, amount_cents: amount });
        continue;
      }
      if (existingPairs.has(cmPairKey(cm.cm_txn_id, inv.invoice_id))) { skipped.push({ ...base, reason: "already" }); continue; }
      if (!(amount > 0)) { skipped.push({ ...base, reason: "zero_amount" }); continue; }
      if (planned + amount > cm.total_cents) { skipped.push({ ...base, reason: "exceeds_credit" }); continue; }
      planned += amount;
      rows.push({
        ...base,
        cm_id: cm.cm_id,
        customer_id: cm.customer_id,
        invoice_id: inv.invoice_id,
        invoice_number: inv.invoice_number,
        order_id: inv.order_id,
        amount_cents: amount,
        applied_at: cm.cm_date > inv.invoice_date ? cm.cm_date : inv.invoice_date,
      });
    }
  }
  return { rows, unlinked, skipped };
}

/** Status nativo de un `customer_payment` según lo aplicado (`apply/route.ts` paso 4; `available` = recién creado). */
export function deriveCreditPaymentStatus(appliedCents: number, amountCents: number): "available" | "partially_applied" | "applied" {
  if (appliedCents <= 0) return "available";
  return appliedCents >= amountCents ? "applied" : "partially_applied";
}

// ── Lecturas ─────────────────────────────────────────────────────────────

export async function loadBackfilledCreditMemos(db: QueryableDb, runId: string): Promise<BackfilledCreditMemo[]> {
  const { rows } = await db.query(
    `SELECT id, qb_txn_id, credit_memo_number, customer_id, total::bigint AS total_cents,
            metadata->>'qb_ref_number' AS ref_number,
            to_char(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS cm_date,
            CASE WHEN jsonb_typeof(metadata->'qb_linked_txns') = 'array' THEN metadata->'qb_linked_txns' ELSE '[]'::jsonb END AS linked_txns
       FROM pos_credit_memo
      WHERE deleted_at IS NULL AND status = 'completed' AND qb_txn_id IS NOT NULL
        AND metadata->'qb_backfill'->>'run_id' = $1
      ORDER BY completed_at, qb_txn_id`,
    [runId]
  );
  return rows.map((r) => ({
    cm_id: String(r.id),
    cm_txn_id: String(r.qb_txn_id),
    cm_ref_number: r.ref_number == null ? null : String(r.ref_number),
    credit_memo_number: String(r.credit_memo_number),
    customer_id: String(r.customer_id),
    total_cents: Number(r.total_cents),
    cm_date: String(r.cm_date),
    linked_txns: (r.linked_txns ?? []) as QbLinkedTxn[],
  }));
}

/** `findPosInvoiceByQbTxnId` (las tres formas del enlace) + la fecha de emisión para `applied_at`. */
export async function findLinkedInvoice(db: QueryableDb, txnId: string): Promise<LinkedInvoiceRef | null> {
  const ref = await findPosInvoiceByQbTxnId(db, txnId);
  if (!ref) return null;
  const { rows } = await db.query(
    `SELECT to_char(issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d FROM pos_invoice WHERE id = $1`,
    [ref.invoice_id]
  );
  return { invoice_id: ref.invoice_id, invoice_number: ref.invoice_number, order_id: ref.order_id, invoice_date: String(rows[0]?.d ?? "") };
}

/** Pares (CM TxnID, invoice_id) de aplicaciones vivas de pagos `credit_memo`, y Σ aplicado por CM. */
export async function loadExistingCreditApplications(db: QueryableDb): Promise<{ pairs: Set<string>; appliedByCm: Map<string, number> }> {
  const { rows } = await db.query(
    `SELECT cp.metadata->>'qb_txn_id' AS cm_txn, pa.invoice_id, pa.amount_applied::bigint AS amount
       FROM payment_application pa JOIN customer_payment cp ON cp.id = pa.payment_id AND cp.deleted_at IS NULL
      WHERE pa.deleted_at IS NULL AND pa.voided_at IS NULL AND cp.type = 'credit_memo' AND cp.metadata->>'qb_txn_id' IS NOT NULL`
  );
  const pairs = new Set<string>();
  const appliedByCm = new Map<string, number>();
  for (const r of rows) {
    const cmTxn = String(r.cm_txn);
    if (r.invoice_id != null) pairs.add(cmPairKey(cmTxn, String(r.invoice_id)));
    appliedByCm.set(cmTxn, (appliedByCm.get(cmTxn) ?? 0) + Number(r.amount));
  }
  return { pairs, appliedByCm };
}

/** Plan completo: CMs del run (marcador) desde la DB, facturas resueltas por TxnID, pares ya existentes. */
export async function planCreditMemoApplications(cms: readonly BackfilledCreditMemo[], db: QueryableDb): Promise<CreditMemoApplicationPlan> {
  const resolved = new Map<string, LinkedInvoiceRef | null>();
  for (const cm of cms) {
    for (const l of negativeInvoiceLinks(cm)) {
      if (!resolved.has(l.txn_id)) resolved.set(l.txn_id, await findLinkedInvoice(db, l.txn_id));
    }
  }
  const existing = await loadExistingCreditApplications(db);
  return planCreditMemoApplicationRows(cms, resolved, existing.pairs, existing.appliedByCm);
}

// ── Escritura ────────────────────────────────────────────────────────────

export interface CreditApplicationsReport extends TypeApplyReport {
  /** Pagos `credit_memo` creados (los reusados no cuentan). */
  payments_created: number;
  applications_created: number;
}

interface ExistingPayment {
  id: string;
  display_id: number | null;
  status: string;
  amount_cents: number;
}

async function findCreditPayment(db: QueryableDb, cmTxnId: string): Promise<ExistingPayment | null> {
  const { rows } = await db.query(
    `SELECT id, display_id, status, amount::bigint AS amount_cents FROM customer_payment
      WHERE deleted_at IS NULL AND type = 'credit_memo' AND metadata->>'qb_txn_id' = $1
      ORDER BY created_at LIMIT 1`,
    [cmTxnId]
  );
  const r = rows[0];
  if (!r) return null;
  return { id: String(r.id), display_id: r.display_id == null ? null : Number(r.display_id), status: String(r.status), amount_cents: Number(r.amount_cents) };
}

/** Limpieza de UN CM tras fallo: sólo pagos/aplicaciones/pipeline del marcador `CreditMemoApplication` (NUNCA el `pos_credit_memo`, que comparte TxnID). */
async function cleanupCreditMemoApplication(db: QueryableDb, runId: string, cmTxnId: string): Promise<void> {
  const mark = `metadata->'qb_backfill'->>'run_id' = $1 AND metadata->'qb_backfill'->>'txn_id' = $2 AND metadata->'qb_backfill'->>'txn_type' = 'CreditMemoApplication'`;
  await db.query(
    `DELETE FROM qb_order_pipeline WHERE step = 'apply_payment' AND payload->>'run_id' = $1 AND qb_txn_id = $2
        AND reference_id IN (SELECT id FROM payment_application WHERE ${mark})`,
    [runId, cmTxnId]
  );
  await db.query(`DELETE FROM payment_application WHERE ${mark}`, [runId, cmTxnId]);
  await db.query(`DELETE FROM customer_payment WHERE ${mark}`, [runId, cmTxnId]);
}

/** Un CM por transacción; bloqueado-y-sigue como `applyType`. `apply=false` sólo cuenta. */
export async function applyCreditMemoApplications(
  ctx: SalesApplyContext,
  cms: readonly BackfilledCreditMemo[],
  plan: CreditMemoApplicationPlan,
  apply: boolean
): Promise<CreditApplicationsReport> {
  const report: CreditApplicationsReport = { already: 0, create: 0, created: [], blocked: [], payments_created: 0, applications_created: 0 };
  report.already = plan.skipped.filter((s) => s.reason === "already").length;
  const byCm = new Map<string, CreditMemoApplicationRow[]>();
  for (const row of plan.rows) byCm.set(row.cm_txn_id, [...(byCm.get(row.cm_txn_id) ?? []), row]);
  report.create = byCm.size;
  if (!apply) return report;

  for (const cm of cms) {
    const rows = byCm.get(cm.cm_txn_id);
    if (!rows || rows.length === 0) continue;
    const outcome: DocOutcome = { txn_id: cm.cm_txn_id };
    try {
      await ctx.client.query("BEGIN");
      const result = await applyOneCreditMemo(ctx, cm, rows);
      if (!result.ok) {
        await ctx.client.query("ROLLBACK");
        await cleanupCreditMemoApplication(ctx.client, ctx.runId, cm.cm_txn_id);
        report.blocked.push({ ...outcome, blocked_reason: result.reason });
        ctx.log(`  [credit_application] ${cm.cm_txn_id} BLOQUEADO: ${result.reason}`);
        continue;
      }
      await ctx.client.query("COMMIT");
      report.created.push({ ...outcome, created: result.id });
      report.payments_created += result.payment_created ? 1 : 0;
      report.applications_created += rows.length;
      ctx.log(`  [credit_application] ${cm.cm_txn_id} → ${result.id}`);
    } catch (err) {
      await ctx.client.query("ROLLBACK").catch(() => undefined);
      await cleanupCreditMemoApplication(ctx.client, ctx.runId, cm.cm_txn_id).catch((e: Error) => ctx.log(`  cleanup ${cm.cm_txn_id} falló: ${e.message}`));
      report.blocked.push({ ...outcome, blocked_reason: (err as Error).message });
      ctx.log(`  [credit_application] ${cm.cm_txn_id} ERROR: ${(err as Error).message}`);
    }
  }
  return report;
}

type OneResult = { ok: true; id: string; payment_created: boolean } | { ok: false; reason: string };

async function applyOneCreditMemo(ctx: SalesApplyContext, cm: BackfilledCreditMemo, rows: CreditMemoApplicationRow[]): Promise<OneResult> {
  const marker = backfillMarker(ctx.runId, cm.cm_txn_id, "CreditMemoApplication");
  const existing = await findCreditPayment(ctx.client, cm.cm_txn_id);
  if (existing && !["available", "partially_applied", "applied"].includes(existing.status)) {
    return { ok: false, reason: `payment_${existing.status}` };
  }
  const { appliedByCm } = await loadExistingCreditApplications(ctx.client);
  const newCents = rows.reduce((s, r) => s + r.amount_cents, 0);
  const totalApplied = (appliedByCm.get(cm.cm_txn_id) ?? 0) + newCents;
  const amountCents = existing ? existing.amount_cents : cm.total_cents;
  if (totalApplied > amountCents) return { ok: false, reason: "exceeds_credit" };
  const status = deriveCreditPaymentStatus(totalApplied, amountCents);
  const receivedAt = businessInstant(cm.cm_date);

  // ORDEN IMPORTA (ver `create-sales-payment.ts`): primero TODO lo que va por
  // module service (su propia conexión), los writes crudos al final.
  let paymentId: string;
  let displayId: number | null;
  let paymentCreated = false;
  if (existing) {
    paymentId = existing.id;
    displayId = existing.display_id;
  } else {
    displayId = await allocatePaymentDisplayId(ctx.client);
    paymentId = firstId(
      await ctx.services.financeService.createCustomerPayments({
        customer_id: cm.customer_id,
        display_id: displayId,
        amount: cm.total_cents,
        method: "credit_memo",
        reference: cm.credit_memo_number,
        notes: `Store Credit generated from Return/Credit Memo (recreado desde QuickBooks CreditMemo ${cm.cm_ref_number ?? ""}, TxnID ${cm.cm_txn_id}). No se re-sincroniza.`,
        received_at: receivedAt,
        created_by: BACKFILL_ACTOR,
        source: "pos",
        type: "credit_memo",
        status,
        medusa_payment_synced: false,
        metadata: {
          qb_txn_id: cm.cm_txn_id,
          qb_sync_status: "synced",
          qb_synced_at: marker.imported_at,
          manually_imported: true,
          qb_backfill: marker,
        },
      })
    );
    paymentCreated = true;
  }
  const applications: { applicationId: string; row: CreditMemoApplicationRow }[] = [];
  for (const row of rows) {
    const applicationId = firstId(
      await ctx.services.financeService.createPaymentApplications({
        payment_id: paymentId,
        invoice_id: row.invoice_id,
        invoice_number: row.invoice_number,
        order_id: row.order_id,
        amount_applied: row.amount_cents,
        applied_at: businessInstant(row.applied_at),
        applied_by: BACKFILL_ACTOR,
        metadata: { qb_backfill: marker, qb_invoice_txn_id: row.invoice_txn_id, credit_memo_id: cm.cm_id },
      })
    );
    applications.push({ applicationId, row });
  }

  // ── SQL crudo (transaccional) ──
  if (paymentCreated) await backdateRows(ctx.client, "customer_payment", [paymentId], receivedAt);
  else await ctx.client.query(`UPDATE customer_payment SET status = $1, updated_at = now() WHERE id = $2`, [status, paymentId]);
  // `pos_invoice.amount_paid/balance_due/status` NO se tocan: la factura
  // backfilleada ya lleva el saldo del header de QB. Sólo el método, si falta.
  const { rows: methodRows } = await ctx.client.query(
    `UPDATE pos_invoice SET payment_method = 'credit_memo', updated_at = now()
      WHERE id = ANY($1::text[]) AND deleted_at IS NULL AND payment_method IS NULL RETURNING id`,
    [applications.map((a) => a.row.invoice_id)]
  );
  const methodSet = new Set(methodRows.map((r) => String(r.id)));
  for (const { applicationId, row } of applications) {
    await backdateRows(ctx.client, "payment_application", [applicationId], businessInstant(row.applied_at));
    if (methodSet.has(row.invoice_id)) {
      // Rastro para que `rollbackSales` pueda deshacer el backfill del método.
      await ctx.client.query(
        `UPDATE payment_application SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"set_invoice_payment_method": true}'::jsonb WHERE id = $1`,
        [applicationId]
      );
    }
    await seedPipelineRow(ctx.client, ctx.runId, {
      orderId: row.order_id, referenceId: applicationId, referenceType: "payment_application", step: "apply_payment", status: "confirmed",
      qbTxnId: cm.cm_txn_id, qbRefNumber: cm.cm_ref_number, medusaRefNumber: displayId != null ? `PAY-${displayId}` : null,
      payload: {
        txn_type: "CreditMemo",
        order_id: row.order_id,
        invoice_id: row.invoice_id,
        payment_id: paymentId,
        amount_applied: row.amount_cents,
        application_id: applicationId,
      },
    });
  }
  return { ok: true, id: `PAY-${displayId ?? "?"} (${rows.length} aplic.${paymentCreated ? "" : ", pago reusado"})`, payment_created: paymentCreated };
}
