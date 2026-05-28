/**
 * GET /admin/customer-payments/:id — get a single payment with applications + customer
 * PATCH /admin/customer-payments/:id — update method / card_brand / pos_payment_method / reference
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Modules } from "@medusajs/utils";

import { resolveQbPaymentMethodForPayment } from "../../../../lib/quickbooks/payment-method-sanitizer";
import { writePipelineRow } from "../../../../lib/quickbooks/qb-pipeline";
import { FINANCE_MODULE } from "../../../../modules/finance";
import { INVOICE_MODULE } from "../../../../modules/invoices";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const id = req.params.id!;
  const financeService = req.scope.resolve(FINANCE_MODULE);
  const invoiceService = req.scope.resolve(INVOICE_MODULE);
  const customerModule = req.scope.resolve(Modules.CUSTOMER);

  try {
    const payment = await financeService.retrieveCustomerPayment(id, {
      relations: ["applications"],
    });
    if (!payment) return res.status(404).json({ error: "Payment not found" });

    // Enrich with customer
    let customer = null;
    try {
      const [cust] = await customerModule.listCustomers(
        { id: [payment.customer_id] },
        {
          select: [
            "id",
            "first_name",
            "last_name",
            "email",
            "phone",
            "company_name",
          ],
        }
      );
      customer = cust ?? null;
    } catch {
      /* non-fatal */
    }

    // Enrich applications with invoice numbers
    const applications: any[] = payment.applications ?? [];
    const invoiceIds = [
      ...new Set(applications.map((a: any) => a.invoice_id).filter(Boolean)),
    ];
    const invoiceMap: Record<string, any> = {};
    if (invoiceIds.length) {
      try {
        const invoices = await invoiceService.listPosInvoices({
          id: invoiceIds,
        });
        invoices.forEach((inv: any) => {
          invoiceMap[inv.id] = inv;
        });
      } catch {
        /* non-fatal */
      }
    }

    // Enrich applications with order.metadata.document_number so the
    // Credit Statement can label rows as "Deposit for Order S#####"
    // instead of the raw UUID slice.
    const orderIds = [
      ...new Set(applications.map((a: any) => a.order_id).filter(Boolean)),
    ];
    const docNumberByOrder = new Map<string, string | null>();
    if (orderIds.length) {
      try {
        const { getDbPool } = require("../../../../api/utils/db-pool");
        const pool = getDbPool();
        const { rows: orderRows } = await pool.query(
          `SELECT id, NULLIF(metadata->>'document_number','') AS document_number
           FROM "order" WHERE id = ANY($1::text[])`,
          [orderIds]
        );
        for (const r of orderRows) docNumberByOrder.set(r.id, r.document_number);
      } catch {
        /* non-fatal */
      }
    }

    const enrichedApps = applications.map((a: any) => ({
      ...a,
      invoice: a.invoice_id ? (invoiceMap[a.invoice_id] ?? null) : null,
      order_document_number: a.order_id
        ? (docNumberByOrder.get(a.order_id) ?? null)
        : null,
    }));

    // Compute balances.
    // Business rule: only applications bound to an invoice count as
    // "applied". Order-only applications (invoice_id IS NULL with an
    // order_id) are "reserved" — they consume the credit but should never
    // appear as Applied on the payment because no real revenue line exists
    // yet. available = amount − applied − reserved − refunded.
    const activeApps = enrichedApps.filter((a: any) => !a.voided_at);
    const amountApplied = activeApps
      .filter((a: any) => !!a.invoice_id)
      .reduce((s: number, a: any) => s + Number(a.amount_applied ?? 0), 0);
    const amountReserved = activeApps
      .filter((a: any) => !a.invoice_id && a.order_id)
      .reduce((s: number, a: any) => s + Number(a.amount_applied ?? 0), 0);
    const availableBalance = Math.max(
      0,
      Number(payment.amount) - amountApplied - amountReserved
    );

    // For credit_memo payments, look up the originating pos_credit_memo
    let sourceCreditMemo: { id: string; credit_memo_number: string } | null =
      null;
    if ((payment as any).type === "credit_memo" && (payment as any).reference) {
      try {
        const { getDbPool } = require("../../../../api/utils/db-pool");
        const pool = getDbPool();
        const { rows } = await pool.query(
          `SELECT id, credit_memo_number FROM pos_credit_memo WHERE credit_memo_number = $1 AND deleted_at IS NULL LIMIT 1`,
          [(payment as any).reference]
        );
        if (rows[0])
          sourceCreditMemo = {
            id: rows[0].id,
            credit_memo_number: rows[0].credit_memo_number,
          };
      } catch {
        /* non-fatal */
      }
    }

    return res.json({
      payment: {
        ...payment,
        applications: enrichedApps,
        customer,
        amount_applied: amountApplied,
        amount_reserved: amountReserved,
        available_balance: availableBalance,
        source_credit_memo: sourceCreditMemo,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}

const VALID_METHODS = [
  "cash",
  "check",
  "card",
  "ach",
  "zelle",
  "credit_memo",
  "stripe",
  "authorize_net",
  "other",
  "credit_card",
  "debit_card",
];

const VALID_CARD_BRANDS = [
  "visa",
  "mastercard",
  "amex",
  "discover",
  "capital_one",
];

// QB FullName map is imported from lib/quickbooks/order-flow-core — single
// source of truth shared by this edit route and the Sales Receipt / Payment
// creation flow. Keeps the PaymentMethodRef consistent across both code paths.

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  const id = req.params.id!;
  const { method, pos_payment_method, card_brand, reference } = req.body as {
    method?: string;
    pos_payment_method?: string;
    card_brand?: string | null;
    reference?: string;
  };
  const financeService = req.scope.resolve(FINANCE_MODULE);

  try {
    const payment = await financeService.retrieveCustomerPayment(id);
    if (!payment) return res.status(404).json({ error: "Payment not found" });

    if (payment.status === "voided") {
      return res.status(400).json({ error: "Cannot edit a voided payment" });
    }
    if (method && !VALID_METHODS.includes(method)) {
      return res.status(400).json({ error: `Invalid method: ${method}` });
    }
    if (
      card_brand !== undefined &&
      card_brand !== null &&
      !VALID_CARD_BRANDS.includes(card_brand)
    ) {
      return res
        .status(400)
        .json({ error: `Invalid card_brand: ${card_brand}` });
    }

    const meta = (payment.metadata as Record<string, any>) ?? {};
    const fields: Record<string, any> = {};
    if (method) fields.method = method;
    if (reference !== undefined) fields.reference = reference;
    if (card_brand !== undefined) fields.card_brand = card_brand;
    if (pos_payment_method !== undefined) {
      fields.metadata = { ...meta, pos_payment_method };
    }

    await financeService.updateCustomerPayments({ id, ...fields });

    // ── Sync pos_invoice + invoice_payment payment_method ────────────────
    // When the payment method changes, propagate it to every linked PosInvoice
    // and to the matching InvoicePayment record for each application.
    if (
      pos_payment_method !== undefined &&
      pos_payment_method !== meta.pos_payment_method
    ) {
      // continue to propagate granular pos_payment_method below
      // (PosInvoice's payment_method column stores the granular value)
      (async () => {
        try {
          const invoiceService = req.scope.resolve(INVOICE_MODULE);
          const apps: any[] = await financeService
            .listPaymentApplications({ payment_id: id })
            .catch(() => []);

          const toNum = (v: any): number => {
            if (v == null) return 0;
            if (typeof v === "number") return v;
            if (typeof v === "string") return Number(v);
            if (typeof v === "object") {
              if ("toNumber" in v) return (v as any).toNumber();
              if ("numeric" in v) return Number((v as any).numeric);
              if ("value" in v) return Number((v as any).value);
            }
            return Number(v) || 0;
          };

          for (const app of apps) {
            if (!app.invoice_id) continue;

            // 1. Update the invoice's payment_method column (PAYMENT column in list)
            // Cast required: DB stores detailed methods (e.g. 'visa') beyond the TS enum
            await invoiceService
              .updatePosInvoices({
                id: app.invoice_id,
                payment_method: pos_payment_method as any,
              })
              .catch(() => {});

            // 2. Update the matching invoice_payment record (matched by amount)
            const ipays: any[] = await invoiceService
              .listInvoicePayments({ invoice_id: app.invoice_id })
              .catch(() => []);
            const appAmt = toNum(app.amount_applied);
            for (const ip of ipays) {
              if (Math.abs(toNum(ip.amount) - appAmt) < 1) {
                await invoiceService
                  .updateInvoicePayments({
                    id: ip.id,
                    payment_method: pos_payment_method,
                  })
                  .catch(() => {});
              }
            }
          }
        } catch {
          // non-fatal — invoice sync failure should not block the response
        }
      })();
    }

    // ── QB re-sync: update PaymentMethodRef in QuickBooks ────────────────
    // Trigger when method, card_brand, or pos_payment_method changed. The
    // canonical resolver derives the QB FullName from (method, card_brand):
    //   credit_card → brand (Visa, Capital One, …); else → method (Check, Debit Card, …)
    const methodChanged =
      method !== undefined && method !== (payment as any).method;
    const brandChanged =
      card_brand !== undefined && card_brand !== (payment as any).card_brand;
    const posMethodChanged =
      pos_payment_method !== undefined &&
      pos_payment_method !== meta.pos_payment_method;

    if (methodChanged || brandChanged || posMethodChanged) {
      const finalMethod = method ?? (payment as any).method;
      const finalBrand =
        card_brand !== undefined ? card_brand : (payment as any).card_brand;
      const qbMethodName =
        resolveQbPaymentMethodForPayment(finalMethod, finalBrand) ??
        pos_payment_method ??
        finalMethod;
      // Two markers tag a payment as SR-embedded:
      //   - is_sales_receipt_payment=true → manual Complete Order SR flow.
      //   - qb_source='sales_receipt'   → Dejavoo terminal-linked SR flow.
      // Both must route through SalesReceiptMod here (NOT ReceivePaymentMod),
      // otherwise the Mod uses a SR TxnID against a ReceivePayment endpoint and
      // fails silently (or updates the wrong entity).
      const isSalesReceiptPayment =
        meta.is_sales_receipt_payment === true ||
        meta.qb_source === "sales_receipt";
      const orderId = meta.order_id as string | undefined;

      // Payment label for the QB pipeline row — matches how Payments appear
      // elsewhere (e.g. PAY-2070). Falls back to reference if display_id missing.
      const paymentLabel =
        (payment as any).display_id != null
          ? `PAY-${(payment as any).display_id}`
          : ((payment as any).reference ?? null);

      if (isSalesReceiptPayment && orderId) {
        // For Sales Receipt payments: mod the Sales Receipt (not ReceivePayment).
        // Delegates to updateSalesReceiptInQb so we get:
        //   1. Cache hit / fresh-query fallback for EditSequence.
        //   2. Automatic retry on QB Error 3200 (stale EditSequence): invalidate
        //      cache → fetch fresh → retry mod once.
        (async () => {
          try {
            const { Client } = require("pg");
            const pool = new Client({
              connectionString: process.env.DATABASE_URL,
            });
            await pool.connect();

            const { rows: pipeRows } = await pool.query(
              `SELECT qb_txn_id FROM qb_order_pipeline
                             WHERE order_id = $1 AND step = 'sales_receipt' AND status = 'confirmed'
                             ORDER BY created_at DESC LIMIT 1`,
              [orderId]
            );
            const srTxnId = pipeRows[0]?.qb_txn_id as string | undefined;
            await pool.end();

            if (!srTxnId) {
              req.scope
                .resolve("logger")
                ?.warn?.(
                  `[PAYMENT PATCH] Could not find SR TxnID for order ${orderId} — skipping QB sync`
                );
              return;
            }

            // Write a 'pending' pipeline row immediately so the operation is visible
            // in the QB Sales Pipeline the moment the user clicks Save — before
            // we start the (potentially slow) fresh EditSequence query that runs when
            // the cache is cold. The onSubmit callback below transitions this same
            // row in-place to 'submitted' once the bridge accepts the Mod.
            req.scope
              .resolve("logger")
              ?.info?.(
                `[PAYMENT PATCH] Writing pending pipeline row for SR ${srTxnId} (payment ${paymentLabel}, order ${orderId})`
              );
            try {
              const pipelineRowId = await writePipelineRow({
                orderId: orderId ?? null,
                referenceId: id,
                referenceType: "customer_payment",
                step: "payment_method_change",
                status: "pending",
                qbTxnId: srTxnId,
                medusaRefNumber: paymentLabel,
              });
              req.scope
                .resolve("logger")
                ?.info?.(
                  `[PAYMENT PATCH] Pending pipeline row written: ${pipelineRowId}`
                );
            } catch (writeErr: any) {
              req.scope
                .resolve("logger")
                ?.error?.(
                  `[PAYMENT PATCH] Failed to write pending pipeline row: ${writeErr.message}`
                );
            }

            const {
              updateSalesReceiptInQb,
            } = require("../../../../lib/quickbooks/client/sales-receipts");

            // onSubmit fires immediately after the Bridge accepts each Mod (including
            // the retry after 3200) — writes a pipeline row with status='submitted'
            // so the operation is visible while WebConnector is still processing it.
            // A subscriber transitions the row to 'confirmed'/'failed' on completion.
            const result = await updateSalesReceiptInQb(
              {
                txnId: srTxnId,
                paymentMethod: qbMethodName,
              },
              {
                onSubmit: async (operationId: string) => {
                  req.scope
                    .resolve("logger")
                    ?.info?.(
                      `[PAYMENT PATCH] Queued SalesReceiptMod for ${srTxnId} — PaymentMethod → ${qbMethodName} (opId=${operationId})`
                    );
                  // On retry, the row may already have been reset to 'pending' by
                  // onRetryStart (ideal path), OR the subscriber may have marked it
                  // 'failed' before onRetryStart ran (race). Two-step transition
                  // covers both: first 'pending' (which reactivates failed rows),
                  // then 'submitted' (which matches the pending row in-place). Net
                  // result: always a single row, ending in Submitted with the
                  // current attempt's opId.
                  await writePipelineRow({
                    orderId: orderId ?? null,
                    referenceId: id,
                    referenceType: "customer_payment",
                    step: "payment_method_change",
                    status: "pending",
                    qbTxnId: srTxnId,
                    medusaRefNumber: paymentLabel,
                  }).catch(() => {});
                  await writePipelineRow({
                    orderId: orderId ?? null,
                    referenceId: id,
                    referenceType: "customer_payment",
                    step: "payment_method_change",
                    status: "submitted",
                    bridgeOpId: operationId,
                    qbTxnId: srTxnId,
                    medusaRefNumber: paymentLabel,
                  }).catch(() => {});
                },
                onRetryStart: async (failedOpId: string) => {
                  // Fired when 3200 is detected and the helper is about to fetch a
                  // fresh EditSequence and retry the Mod. Reset the row back to
                  // 'pending' to null out bridge_op_id — this prevents the Failed
                  // subscriber from matching the failed op to this row while the
                  // retry is in flight. onSubmit will transition it back to
                  // Submitted once the retry Mod is accepted.
                  req.scope
                    .resolve("logger")
                    ?.info?.(
                      `[PAYMENT PATCH] Retrying after stale EditSequence — resetting pipeline row (failed opId=${failedOpId})`
                    );
                  await writePipelineRow({
                    orderId: orderId ?? null,
                    referenceId: id,
                    referenceType: "customer_payment",
                    step: "payment_method_change",
                    status: "pending",
                    qbTxnId: srTxnId,
                    medusaRefNumber: paymentLabel,
                  }).catch(() => {});
                },
              }
            );

            if (!result.success) {
              req.scope
                .resolve("logger")
                ?.warn?.(
                  `[PAYMENT PATCH] QB SalesReceiptMod failed for ${srTxnId}: ${result.error}`
                );
            }
          } catch (qbErr: any) {
            req.scope
              .resolve("logger")
              ?.warn?.(
                `[PAYMENT PATCH] QB SalesReceiptMod failed (non-fatal): ${qbErr.message}`
              );
          }
        })();
      } else {
        // Regular ReceivePayment: always query QB fresh for current EditSequence.
        // Cache is unreliable here — QB bumps EditSequence on every Mod/reconcile.
        const qbTxnId = meta.qb_txn_id as string | undefined;
        if (qbTxnId && qbTxnId !== "SYNCED_VIA_RECEIPT") {
          (async () => {
            try {
              const {
                bridgeFetch,
                pollRawOperationResult,
              } = require("../../../../lib/quickbooks/client/core");
              const {
                cacheEditSequence,
              } = require("../../../../lib/quickbooks/qb-pipeline");

              // Always query QB to get the current EditSequence (never rely on cache)
              let editSeq: string | undefined;
              const qResp = await bridgeFetch(
                "GET",
                `/api/payments/${qbTxnId}`
              );
              if (qResp?.operationId) {
                const raw = await pollRawOperationResult(qResp.operationId);
                const ret =
                  raw?.QBXML?.QBXMLMsgsRs?.ReceivePaymentQueryRs
                    ?.ReceivePaymentRet ??
                  raw?.QBXMLMsgsRs?.ReceivePaymentQueryRs?.ReceivePaymentRet ??
                  raw?.ReceivePaymentRet;
                editSeq = ret?.EditSequence;
              }

              if (editSeq) {
                const modResp = await bridgeFetch(
                  "PUT",
                  `/api/payments/${qbTxnId}`,
                  {
                    EditSequence: editSeq,
                    paymentMethod: qbMethodName,
                  }
                );
                req.scope
                  .resolve("logger")
                  ?.info?.(
                    `[PAYMENT PATCH] Queued ReceivePaymentMod for ${qbTxnId} — PaymentMethod → ${qbMethodName}`
                  );
                await writePipelineRow({
                  referenceId: id,
                  referenceType: "customer_payment",
                  step: "payment_method_change",
                  status: "submitted",
                  bridgeOpId: modResp?.operationId ?? null,
                  qbTxnId: qbTxnId,
                  medusaRefNumber: paymentLabel,
                }).catch(() => {});
                // Poll Mod result to cache the fresh EditSequence for future mods
                if (modResp?.operationId) {
                  try {
                    const modRaw = await pollRawOperationResult(
                      modResp.operationId
                    );
                    const modRet =
                      modRaw?.QBXML?.QBXMLMsgsRs?.ReceivePaymentModRs
                        ?.ReceivePaymentRet ??
                      modRaw?.QBXMLMsgsRs?.ReceivePaymentModRs
                        ?.ReceivePaymentRet ??
                      modRaw?.ReceivePaymentRet;
                    const newEditSeq = modRet?.EditSequence;
                    if (newEditSeq) {
                      await cacheEditSequence("payment", qbTxnId, newEditSeq);
                      req.scope
                        .resolve("logger")
                        ?.info?.(
                          `[PAYMENT PATCH] Updated EditSequence cache for ${qbTxnId} → ${newEditSeq}`
                        );
                    }
                  } catch {
                    /* non-fatal */
                  }
                }
              }
            } catch (qbErr: any) {
              req.scope
                .resolve("logger")
                ?.warn?.(
                  `[PAYMENT PATCH] QB ReceivePaymentMod failed (non-fatal): ${qbErr.message}`
                );
            }
          })();
        }
      }
    }

    const updated = await financeService.retrieveCustomerPayment(id);
    return res.json({ payment: updated });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
