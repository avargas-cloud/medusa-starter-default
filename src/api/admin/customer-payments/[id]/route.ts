/**
 * GET /admin/customer-payments/:id — get a single payment with applications + customer
 * PATCH /admin/customer-payments/:id — update method / pos_payment_method / reference
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Modules } from "@medusajs/utils";

import { QB_PAYMENT_METHOD_NAMES } from "../../../../lib/quickbooks/order-flow-core";
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

    const enrichedApps = applications.map((a: any) => ({
      ...a,
      invoice: a.invoice_id ? (invoiceMap[a.invoice_id] ?? null) : null,
    }));

    // Compute balances
    const activeApps = enrichedApps.filter((a: any) => !a.voided_at);
    const amountApplied = activeApps.reduce(
      (s: number, a: any) => s + Number(a.amount_applied ?? 0),
      0
    );
    const availableBalance = Math.max(
      0,
      Number(payment.amount) - amountApplied
    );

    return res.json({
      payment: {
        ...payment,
        applications: enrichedApps,
        customer,
        amount_applied: amountApplied,
        available_balance: availableBalance,
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
];

// QB FullName map is imported from lib/quickbooks/order-flow-core — single
// source of truth shared by this edit route and the Sales Receipt / Payment
// creation flow. Keeps the PaymentMethodRef consistent across both code paths.

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  const id = req.params.id!;
  const { method, pos_payment_method, reference } = req.body as {
    method?: string;
    pos_payment_method?: string;
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

    const meta = (payment.metadata as Record<string, any>) ?? {};
    const fields: Record<string, any> = {};
    if (method) fields.method = method;
    if (reference !== undefined) fields.reference = reference;
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
    // Only attempt if the payment method actually changed and QB sync is possible.
    if (
      pos_payment_method !== undefined &&
      pos_payment_method !== meta.pos_payment_method
    ) {
      const qbMethodName =
        QB_PAYMENT_METHOD_NAMES[pos_payment_method] ?? pos_payment_method;
      const isSalesReceiptPayment = meta.is_sales_receipt_payment === true;
      const orderId = meta.order_id as string | undefined;

      if (isSalesReceiptPayment && orderId) {
        // For Sales Receipt payments: mod the Sales Receipt (not ReceivePayment).
        // The SR TxnID is in qb_order_pipeline; EditSequence is in qb_edit_sequence_cache.
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

            let editSeq: string | undefined;
            if (srTxnId) {
              const { rows: cacheRows } = await pool.query(
                `SELECT edit_seq FROM qb_edit_sequence_cache
                                 WHERE entity_type = 'sales_receipt' AND qb_id = $1`,
                [srTxnId]
              );
              editSeq = cacheRows[0]?.edit_seq;
            }
            await pool.end();

            if (srTxnId && editSeq) {
              const {
                bridgeFetch,
              } = require("../../../../lib/quickbooks/client/core");
              const modResp = await bridgeFetch(
                "PUT",
                `/api/sales-receipts/${srTxnId}`,
                {
                  EditSequence: editSeq,
                  PaymentMethod: qbMethodName,
                }
              );
              req.scope
                .resolve("logger")
                ?.info?.(
                  `[PAYMENT PATCH] Queued SalesReceiptMod for ${srTxnId} — PaymentMethod → ${qbMethodName}`
                );
              await writePipelineRow({
                orderId: orderId ?? null,
                referenceId: id,
                referenceType: "customer_payment",
                step: "payment_method_change",
                status: "submitted",
                bridgeOpId: modResp?.operationId ?? null,
                qbTxnId: srTxnId,
                medusaRefNumber: (payment as any).reference ?? null,
              }).catch(() => {});
            } else {
              req.scope
                .resolve("logger")
                ?.warn?.(
                  `[PAYMENT PATCH] Could not find SR TxnID/EditSeq for order ${orderId} — skipping QB sync`
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
                  medusaRefNumber: (payment as any).reference ?? null,
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
