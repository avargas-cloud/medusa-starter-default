/**
 * src/lib/qb-backfill/create-sales-payment.ts
 *
 * ReceivePayment de QB → `customer_payment` del POS + una
 * `payment_application` por cada `AppliedToTxnRet` cuya factura el POS
 * conoce (por TxnID, `findPosInvoiceByQbTxnId`). Una aplicación a una
 * factura desconocida NO bloquea el pago: se crea igual y la aplicación va al
 * reporte como `unlinked_application`. `DiscountAmount` y `SetCredit` no
 * tienen representación en el POS → sólo se reportan.
 *
 * NO toca `pos_invoice.amount_paid/balance_due`: la factura que este mismo
 * backfill creó ya nació con el saldo del header de QB (que incluye este
 * pago); una factura nativa preexistente no se modifica desde acá.
 *
 * Pipeline: `payment` confirmed (`customer_payment`, `PAY-<display_id>`) y un
 * `apply_payment` confirmed por aplicación, keyeado por `papp_` con
 * `reference_type = 'payment_application'` — la forma canónica que exige
 * `row-mutations.ts` (índice único `uq_qb_pipeline_apply_payment_papp`).
 */
import { businessInstant } from "./create-po";
import { derivePaymentStatus, mapQbPaymentMethod } from "./sales-derive";
import { allocatePaymentDisplayId } from "./sales-numbering";
import {
  BACKFILL_ACTOR,
  backdateRows,
  backfillMarker,
  findPosInvoiceByQbTxnId,
  firstId,
  seedPipelineRow,
  type PosInvoiceRef,
  type SalesApplyContext,
} from "./sales-context";
import type { QbReceivePayment, QbReceivePaymentApplication } from "./sales-types";

export interface UnlinkedApplication {
  payment_txn_id: string;
  invoice_txn_id: string;
  invoice_ref_number: string | null;
  amount_cents: number;
}

export interface PaymentNotes {
  unlinked_application: UnlinkedApplication[];
  discount_ignored: Array<{ payment_txn_id: string; invoice_txn_id: string; discount_cents: number }>;
  set_credit_ignored: Array<{ payment_txn_id: string; invoice_txn_id: string; credit_txn_id: string; amount_cents: number }>;
}

export function newPaymentNotes(): PaymentNotes {
  return { unlinked_application: [], discount_ignored: [], set_credit_ignored: [] };
}

export interface PlannedApplication {
  application: QbReceivePaymentApplication;
  invoice: PosInvoiceRef | null;
}

/** Parte PURA del plan: qué aplicaciones se linkean y qué se reporta (dado el resolutor de facturas ya consultado). */
export function planPaymentApplications(rp: QbReceivePayment, resolved: readonly PlannedApplication[], notes: PaymentNotes): PlannedApplication[] {
  const linked: PlannedApplication[] = [];
  for (const p of resolved) {
    const a = p.application;
    if ((a.discount_amount_cents ?? 0) > 0) {
      notes.discount_ignored.push({ payment_txn_id: rp.txn_id, invoice_txn_id: a.txn_id, discount_cents: a.discount_amount_cents ?? 0 });
    }
    for (const c of a.set_credits) {
      notes.set_credit_ignored.push({ payment_txn_id: rp.txn_id, invoice_txn_id: a.txn_id, credit_txn_id: c.credit_txn_id, amount_cents: c.applied_amount_cents });
    }
    if (a.amount_cents <= 0) continue; // línea de sólo-descuento/crédito, sin plata del pago
    if (!p.invoice) {
      notes.unlinked_application.push({ payment_txn_id: rp.txn_id, invoice_txn_id: a.txn_id, invoice_ref_number: a.ref_number, amount_cents: a.amount_cents });
      continue;
    }
    linked.push(p);
  }
  return linked;
}

export type PaymentCreateResult =
  | { ok: true; payment_id: string; display_id: number; applications: number }
  | { ok: false; reason: string; detail?: Record<string, unknown> };

export async function createReceivePaymentFromQb(ctx: SalesApplyContext, rp: QbReceivePayment, notes: PaymentNotes): Promise<PaymentCreateResult> {
  if (!rp.customer_ref) return { ok: false, reason: "no_customer" };
  if (rp.total_amount_cents <= 0) return { ok: false, reason: "zero_total", detail: { total_cents: rp.total_amount_cents } };

  const resolved: PlannedApplication[] = [];
  for (const application of rp.applied) {
    const invoice = application.txn_type === "Invoice" ? await findPosInvoiceByQbTxnId(ctx.client, application.txn_id) : null;
    resolved.push({ application, invoice });
  }
  const linked = planPaymentApplications(rp, resolved, notes);

  const customerId = await ctx.ensureCustomer(rp.customer_ref);
  const pm = mapQbPaymentMethod(rp.payment_method_ref?.full_name);
  const at = businessInstant(rp.txn_date);
  const marker = backfillMarker(ctx.runId, rp.txn_id, "ReceivePayment", rp.via_link);
  const displayId = await allocatePaymentDisplayId(ctx.client);
  const status = derivePaymentStatus(rp);
  const invoiceIds = linked.map((l) => l.invoice!.invoice_id);
  const firstOrderId = linked[0]?.invoice?.order_id ?? null;

  const paymentId = firstId(
    await ctx.services.financeService.createCustomerPayments({
      customer_id: customerId,
      display_id: displayId,
      amount: rp.total_amount_cents,
      method: pm.method,
      card_brand: pm.card_brand,
      reference: rp.ref_number,
      notes: `Recreado desde QuickBooks ReceivePayment ${rp.ref_number ?? ""} (TxnID ${rp.txn_id}). No se re-sincroniza.`,
      received_at: at,
      created_by: BACKFILL_ACTOR,
      source: "pos",
      type: "payment",
      status,
      medusa_payment_synced: false,
      metadata: {
        ...(firstOrderId ? { order_id: firstOrderId, deposit_type: "INVOICE" } : {}),
        pos_payment_method: pm.method,
        card_brand: pm.card_brand,
        qb_payment_method: rp.payment_method_ref?.full_name ?? null,
        qb_deposit_to_account: rp.deposit_to_account_ref?.full_name ?? null,
        invoices_affected: invoiceIds,
        invoices_affected_friendly: linked.map((l) => `INV-${l.invoice!.invoice_number}`),
        qb_txn_id: rp.txn_id,
        qb_ref_number: rp.ref_number,
        qb_edit_sequence: rp.edit_sequence,
        qb_sync_status: "synced",
        qb_synced_at: marker.imported_at,
        manually_imported: true,
        qb_backfill: marker,
      },
      qb: { status: "yes", txn_id: rp.txn_id, edit_sequence: rp.edit_sequence },
    })
  );
  // ORDEN IMPORTA (deadlock medido 2026-09-11, 628 pagos después): los servicios
  // del módulo insertan en SU conexión y sus triggers (`recompute_order_money`)
  // actualizan "order"; si la transacción cruda ya sembró una fila de pipeline
  // con FK a esa orden, la segunda aplicación se queda esperando el lock para
  // siempre. Primero TODO lo que va por servicio; los writes crudos (backdate,
  // pipeline) al final, cuando ya no hay nada que espere por nuestros locks.
  const applications: { applicationId: string; inv: NonNullable<(typeof linked)[number]["invoice"]>; application: (typeof linked)[number]["application"] }[] = [];
  for (const l of linked) {
    const inv = l.invoice!;
    const applicationId = firstId(
      await ctx.services.financeService.createPaymentApplications({
        payment_id: paymentId,
        invoice_id: inv.invoice_id,
        invoice_number: inv.invoice_number,
        order_id: inv.order_id,
        amount_applied: l.application.amount_cents,
        applied_at: at,
        applied_by: BACKFILL_ACTOR,
        metadata: { qb_backfill: marker, qb_invoice_txn_id: l.application.txn_id },
      })
    );
    applications.push({ applicationId, inv, application: l.application });
  }

  await backdateRows(ctx.client, "customer_payment", [paymentId], at);
  await seedPipelineRow(ctx.client, ctx.runId, {
    orderId: firstOrderId, referenceId: paymentId, referenceType: "customer_payment", step: "payment", status: "confirmed",
    qbTxnId: rp.txn_id, qbRefNumber: rp.ref_number, medusaRefNumber: `PAY-${displayId}`,
    payload: { txn_type: "ReceivePayment", edit_sequence: rp.edit_sequence, source: `QB ReceivePayment ${rp.ref_number ?? rp.txn_id}` },
  });
  // La lista de invoices muestra el método de pago desde `pos_invoice.payment_method`
  // (columna PAYMENT): una factura cobrada por ReceivePayment lo hereda del pago que
  // la aplica (sólo si aún no tiene uno — el primero que la toca gana).
  if (pm.invoice_method && applications.length > 0) {
    await ctx.client.query(
      `UPDATE pos_invoice SET payment_method = COALESCE(payment_method, $1), card_brand = COALESCE(card_brand, $2), updated_at = now()
        WHERE id = ANY($3::text[]) AND deleted_at IS NULL`,
      [pm.invoice_method, pm.card_brand ?? null, applications.map((a) => a.inv.invoice_id)]
    );
  }
  for (const { applicationId, inv, application } of applications) {
    await backdateRows(ctx.client, "payment_application", [applicationId], at);
    await seedPipelineRow(ctx.client, ctx.runId, {
      orderId: inv.order_id, referenceId: applicationId, referenceType: "payment_application", step: "apply_payment", status: "confirmed",
      qbTxnId: rp.txn_id, qbRefNumber: rp.ref_number, medusaRefNumber: `PAY-${displayId}`,
      payload: {
        txn_type: "ReceivePayment",
        order_id: inv.order_id,
        invoice_id: inv.invoice_id,
        payment_id: paymentId,
        amount_applied: application.amount_cents,
        application_id: applicationId,
      },
    });
  }
  return { ok: true, payment_id: paymentId, display_id: displayId, applications: linked.length };
}
