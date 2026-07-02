/**
 * POST /admin/invoices/:id/payments  — record a payment against an invoice
 * GET  /admin/invoices/:id/payments  — list all payments for an invoice
 *
 * On POST, the route:
 *   1. Creates an invoice_payment record
 *   2. Re-sums all payments and updates pos_invoice.amount_paid + balance_due
 */

import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { maybeCompleteOrder } from "../../../../../lib/maybe-complete-order";
import { writePipelineRow } from "../../../../../lib/quickbooks/qb-pipeline";
import { FINANCE_MODULE } from "../../../../../modules/finance";
import { INVOICE_MODULE } from "../../../../../modules/invoices";
import { getAppliedInvoiceTotal, getNum } from "../../payment-balance";
import { registerMedusaPayment } from "../../register-medusa-payment";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const id = req.params.id!;
  const invoiceService = req.scope.resolve(INVOICE_MODULE);

  try {
    const payments = await invoiceService.listInvoicePayments(
      { invoice_id: id },
      { order: { paid_at: "DESC" } }
    );
    return res.json({ payments });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const id = req.params.id!;
  const {
    amount,
    payment_method,
    notes,
    created_by,
    paid_at,
    customer_id,
    reference,
  } = req.body as any;
  const invoiceService = req.scope.resolve(INVOICE_MODULE);
  const financeService = req.scope.resolve(FINANCE_MODULE);

  if (!amount || amount <= 0) {
    return res
      .status(400)
      .json({ error: "amount must be a positive number (cents)" });
  }
  if (!payment_method) {
    return res.status(400).json({ error: "payment_method is required" });
  }
  if (!customer_id) {
    return res.status(400).json({
      error:
        "customer_id is required. All payments must be linked to a customer ledger.",
    });
  }

  try {
    // 1. Load the invoice to verify it exists and isn't voided
    const invoice = await invoiceService.retrievePosInvoice(id);
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });
    if (invoice.status === "voided") {
      return res
        .status(400)
        .json({ error: "Cannot add payment to a voided invoice" });
    }

    const paymentDate = paid_at ? new Date(paid_at) : new Date();

    function mapPosMethodToDbEnum(method: string): any {
      if (
        [
          "visa",
          "mastercard",
          "discover",
          "amex",
          "capital_one",
          "debit_card",
        ].includes(method)
      )
        return "card";
      if (
        ["e_check", "checking_account", "transfer", "wire_transfer"].includes(
          method
        )
      )
        return "ach";
      if (["paypal", "money_order"].includes(method)) return "other";
      if (method === "credit") return "credit_memo";
      if (["cash", "check", "zelle"].includes(method)) return method;
      return "other";
    }

    // Fetch strictly continuous sequential payment number
    const pgConnection = req.scope.resolve("__pg_connection__") as any;
    const seqPgRes = await pgConnection
      .raw(`SELECT nextval('custom_payment_seq') AS seq`)
      .catch(() => ({ rows: [{ seq: null }] }));
    const nextPayNum =
      seqPgRes.rows[0]?.seq || seqPgRes.rows[0]?.SEQ
        ? Number(seqPgRes.rows[0].seq || seqPgRes.rows[0].SEQ)
        : null;

    const qbFlowEnabled = process.env.QB_ORDER_FLOW_ENABLED === "true";

    // 2. Create the CustomerPayment (The core AR ledger entry)
    const customerPayment = await financeService.createCustomerPayments({
      customer_id,
      display_id: nextPayNum,
      amount,
      method: mapPosMethodToDbEnum(payment_method),
      reference: reference || null,
      notes: notes || null,
      received_at: paymentDate,
      created_by: created_by || null,
      source: "pos",
      type: "payment",
      status: "applied", // Immediately applied to this invoice
      medusa_payment_synced: false, // will be updated after Medusa sync
      metadata: {
        deposit_type: "INVOICE",
        order_id: invoice.order_id,
        pos_payment_method: payment_method,
        invoices_affected: [id],
        invoices_affected_friendly: [
          `IN-${(invoice as any).invoice_number || id}`,
        ],
        // Show spinner immediately — QB handler will update to 'synced'/'error'
        ...(qbFlowEnabled ? { qb_sync_status: "pending" } : {}),
      },
    });

    // 3. Create the PaymentApplication linking the payment to the invoice
    const paymentApplication = await financeService.createPaymentApplications({
      payment_id: customerPayment.id,
      invoice_id: id,
      invoice_number: String((invoice as any).invoice_number || ""),
      order_id: invoice.order_id,
      amount_applied: amount,
      applied_at: paymentDate,
      applied_by: created_by || null,
    });

    // 4. Create the historic InvoicePayment record
    await invoiceService.createInvoicePayments({
      invoice_id: id,
      amount,
      payment_method,
      notes: notes ?? null,
      created_by: created_by ?? null,
      paid_at: paymentDate,
    });

    // 5. Re-sum all payments and update the invoice status
    const allPayments = await invoiceService.listInvoicePayments({
      invoice_id: id,
    });
    const totalPaid = await getAppliedInvoiceTotal(req.scope, id);
    const balanceDue = Math.max(0, getNum(invoice.total) - totalPaid);
    const newStatus = balanceDue <= 0 ? "paid" : "partial";

    // Backfill pos_invoice.payment_method on the FIRST captured payment when
    // the invoice was created via Skip Payment (payment_method left null).
    const invoiceMethodBackfill = !(invoice as any).payment_method
      ? { payment_method }
      : {};

    await invoiceService.updatePosInvoices({
      id,
      amount_paid: totalPaid,
      balance_due: balanceDue,
      status: newStatus,
      ...invoiceMethodBackfill,
    });

    // 6. Register in Medusa native Payment Module (best-effort, every payment)
    const medusaPaymentId = await registerMedusaPayment(req.scope, {
      order_id: invoice.order_id,
      amount,
      payment_method,
      invoice_total: getNum(invoice.total),
      customer_payment_id: customerPayment.id,
    });
    if (medusaPaymentId) {
      await financeService.updateCustomerPayments({
        id: customerPayment.id,
        medusa_payment_synced: true,
      });
    }

    const updated = await invoiceService.retrievePosInvoice(id);

    // 7. QB Sync — durable pipeline enqueue (no fire-and-forget setTimeout).
    // The 'payment' row is written 'pending' so the consolidator's pending-dispatch
    // pass pushes the ReceivePayment to QB durably (≤1 min) and survives process
    // restarts. The 'apply_payment' row is enqueued 'pending' as well;
    // handlePosPaymentApplied self-requeues it as 'waiting' on the payment row until
    // the ReceivePayment confirms, after which the wake-dependents pass applies it to
    // the invoice automatically.
    //
    // Previously this used status:'waiting' + a setTimeout handler call. A lost timer
    // (process restart mid-flight) stranded the 'payment' row in 'waiting' with no
    // depends_on — a state neither consolidator pass can recover (pending-dispatch
    // only claims 'pending'; wake-dependents needs depends_on→confirmed).
    if (qbFlowEnabled) {
      try {
        await writePipelineRow({
          orderId: invoice.order_id,
          referenceId: customerPayment.id,
          referenceType: "customer_payment",
          step: "payment",
          status: "pending",
          medusaRefNumber: nextPayNum ? `PAY-${nextPayNum}` : null,
        });

        await writePipelineRow({
          orderId: invoice.order_id,
          referenceId: paymentApplication.id,
          referenceType: "payment_application",
          step: "apply_payment",
          status: "pending",
          medusaRefNumber: nextPayNum ? `PAY-${nextPayNum}` : null,
          payload: {
            payment_id: customerPayment.id,
            invoice_id: id,
            order_id: invoice.order_id,
            amount_applied: amount,
            application_id: paymentApplication.id,
          },
        });
      } catch (rowErr: any) {
        console.warn(
          `[invoices/:id/payments] Could not enqueue QB pipeline rows: ${rowErr.message}`
        );
      }
    }

    // Best-effort native completion now that this payment settled against the
    // invoice (idempotent + advisory-locked + non-fatal). The auto-complete
    // subscriber is the retry net if the order isn't eligible yet.
    if (invoice.order_id) {
      try {
        await maybeCompleteOrder(req.scope, invoice.order_id);
      } catch {
        /* non-fatal */
      }
    }

    return res.json({
      invoice: updated,
      payments: allPayments,
      customer_payment: customerPayment,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
