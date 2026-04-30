/**
 * src/jobs/qb-invoice-waiting-gate.ts
 *
 * Fase 3 — Order Pipeline Gate poller.
 *
 * Scans pos_invoice rows where metadata.waiting_qb_items === true (set by the
 * gate at src/api/admin/invoices/route.ts when a sale includes a variant that
 * hasn't received its QuickBooks ListID yet). For each waiting invoice:
 *   1. Re-check variant.metadata.quickbooks_id for each waiting_variant_id
 *   2. If all variants are synced, reconstruct the QB dispatch payload from
 *      the stashed invoice.metadata.qb_dispatch_payload and fire the exact
 *      same pipeline writes + handler chain the invoice POST route would have
 *      fired synchronously.
 *   3. Clear the waiting_qb_items flag
 *
 * Runs every 2 minutes — aligned with the item pipeline poller (1 min) so the
 * typical end-to-end delay for a brand-new product sold at the register is
 * ~60-120 seconds from sale to QB SalesReceipt/Invoice push.
 */
import { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";

import { handleFulfillmentCreated } from "../lib/quickbooks/handlers/handle-fulfillment-created";
import { handlePosPaymentApplied } from "../lib/quickbooks/handlers/handle-pos-payment-applied";
import { handlePosPaymentCreated } from "../lib/quickbooks/handlers/handle-pos-payment-created";
// 1.5.6: handleSalesReceiptCreated import removed — waiting-gate enqueues now.
import {
  writePipelineRow,
  skipSalesOrderPipelineRow,
  skipPendingPaymentRows,
} from "../lib/quickbooks/qb-pipeline";
import { INVOICE_MODULE } from "../modules/invoices";

const MAX_ROWS_PER_TICK = 20;

type DispatchPayload = {
  is_sales_receipt: boolean;
  fulfillment_id: string | null;
  resolved_payment_method: string;
  payment_id_to_emit: string | null;
  applications_to_emit: Array<any>;
  next_pay_num: number | null;
  invoice_number: number;
};

export default async function qbInvoiceWaitingGate(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const invoiceService = container.resolve(INVOICE_MODULE) as any;
  const orderModule = container.resolve(Modules.ORDER);
  const customerModule = container.resolve(Modules.CUSTOMER);
  const knex = (container as any).resolve("__pg_connection__");

  // Find waiting invoices via raw SQL (metadata jsonb filter isn't expressible
  // via query.graph). Limit per tick so a backlog can't monopolize the cron.
  const waitingRes = await knex.raw(
    `SELECT id, order_id, metadata
       FROM pos_invoice
      WHERE metadata ->> 'waiting_qb_items' = 'true'
      ORDER BY created_at ASC
      LIMIT ?`,
    [MAX_ROWS_PER_TICK]
  );
  const waitingInvoices: any[] = waitingRes.rows ?? [];

  if (waitingInvoices.length === 0) return;

  logger.info(
    `[qb-invoice-waiting-gate] checking ${waitingInvoices.length} waiting invoice(s)`
  );

  let promoted = 0;
  let stillWaiting = 0;

  for (const inv of waitingInvoices) {
    try {
      const meta = inv.metadata ?? {};
      const waitingVariantIds: string[] = meta.waiting_variant_ids ?? [];
      const payload: DispatchPayload | undefined = meta.qb_dispatch_payload;

      if (!payload) {
        logger.warn(
          `[qb-invoice-waiting-gate] invoice ${inv.id} is waiting but has no qb_dispatch_payload — clearing flag to unblock`
        );
        await invoiceService.updatePosInvoices({
          id: inv.id,
          metadata: {
            ...meta,
            waiting_qb_items: false,
            waiting_qb_items_error: "missing qb_dispatch_payload",
          },
        });
        continue;
      }

      if (waitingVariantIds.length === 0) {
        logger.warn(
          `[qb-invoice-waiting-gate] invoice ${inv.id} has no waiting_variant_ids — proceeding to dispatch`
        );
      } else {
        // Re-check each waiting variant's quickbooks_id
        const checkRes = await knex.raw(
          `SELECT id, metadata FROM product_variant WHERE id = ANY(?::text[])`,
          [waitingVariantIds]
        );
        const stillMissing = ((checkRes.rows ?? []) as any[])
          .filter((v) => !v.metadata?.quickbooks_id)
          .map((v) => v.id);

        if (stillMissing.length > 0) {
          stillWaiting++;
          continue;
        }
      }

      // All variants are ready → fire the same dispatch the POST route would have.
      // First: rebuild body.items from pos_invoice_item (handlers tolerate an
      // empty array because they re-query order.items, but we pass the real
      // row set for parity with the sync path).
      const itemsRes = await knex.raw(
        `SELECT variant_id, sku, description, quantity, unit_price, total
           FROM pos_invoice_item
          WHERE invoice_id = ?`,
        [inv.id]
      );
      const bodyItems = (itemsRes.rows ?? []).map((r: any) => ({
        variant_id: r.variant_id,
        sku: r.sku,
        description: r.description,
        quantity: Number(r.quantity),
        unit_price: Number(r.unit_price),
        total: Number(r.total),
      }));

      // ── Write upfront pipeline rows (mirrors invoices/route.ts lines 691-789) ─
      if (process.env.QB_ORDER_FLOW_ENABLED === "true") {
        try {
          if (payload.is_sales_receipt) {
            try {
              await skipPendingPaymentRows(
                inv.order_id,
                "Superseded by Sales Receipt — payment embedded in SR"
              );
            } catch {}
            await writePipelineRow({
              orderId: inv.order_id,
              referenceId: inv.id,
              referenceType: "pos_invoice",
              step: "sales_receipt",
              status: "waiting",
              medusaRefNumber: `INV-${payload.invoice_number}`,
            });
          } else {
            const invoicePipelineRowId = await writePipelineRow({
              orderId: inv.order_id,
              referenceId: inv.id,
              referenceType: "pos_invoice",
              step: "invoice",
              status: "waiting",
              medusaRefNumber: `INV-${payload.invoice_number}`,
            });
            if (payload.payment_id_to_emit) {
              await writePipelineRow({
                orderId: inv.order_id,
                referenceId: payload.payment_id_to_emit,
                referenceType: "customer_payment",
                step: "payment",
                status: "waiting",
                medusaRefNumber: payload.next_pay_num
                  ? `PAY-${payload.next_pay_num}`
                  : null,
              });
            }
            for (const app of payload.applications_to_emit ?? []) {
              const applyPayRef = app.payment_id;
              let applyMedusaRef: string | null =
                payload.payment_id_to_emit &&
                app.payment_id === payload.payment_id_to_emit &&
                payload.next_pay_num
                  ? `PAY-${payload.next_pay_num}`
                  : null;
              if (!applyMedusaRef && applyPayRef) {
                try {
                  const payRes = await knex.raw(
                    `SELECT display_id FROM customer_payment WHERE id = ?`,
                    [applyPayRef]
                  );
                  if (payRes.rows[0]?.display_id)
                    applyMedusaRef = `PAY-${payRes.rows[0].display_id}`;
                } catch {}
              }
              await writePipelineRow({
                orderId: inv.order_id,
                referenceId: applyPayRef,
                referenceType: "customer_payment",
                step: "apply_payment",
                status: "waiting",
                dependsOn: invoicePipelineRowId,
                medusaRefNumber: applyMedusaRef,
              });
            }
          }
          try {
            await skipSalesOrderPipelineRow(inv.order_id);
          } catch {}
        } catch (rowErr: any) {
          logger.error(
            `[qb-invoice-waiting-gate] failed to write upfront rows for invoice ${inv.id}: ${rowErr.message}`
          );
        }
      }

      // ── 1.5.6: pipeline-only — enqueue instead of calling handlers directly ──
      try {
        if (payload.is_sales_receipt) {
          const {
            writePipelineRow: enqueueSr,
          } = require("../lib/quickbooks/qb-pipeline");
          await enqueueSr({
            orderId: inv.order_id,
            referenceId: inv.id,
            referenceType: "invoice",
            step: "sales_receipt",
            status: "pending",
            payload: {
              invoice_id: inv.id,
              items: bodyItems,
              fulfillment_id: payload.fulfillment_id ?? undefined,
              payment_method: payload.resolved_payment_method,
              payment_id: payload.payment_id_to_emit,
            },
          });
          logger.info(
            `[qb-invoice-waiting-gate] 📥 Enqueued sales_receipt for ${inv.order_id} / ${inv.id}`
          );
        } else {
          await handleFulfillmentCreated(
            {
              order_id: inv.order_id,
              invoice_id: inv.id,
              items: bodyItems,
              fulfillment_id: payload.fulfillment_id ?? undefined,
            } as any,
            orderModule,
            customerModule,
            container,
            logger
          );
        }

        await new Promise((r) => setTimeout(r, 250));

        if (payload.payment_id_to_emit) {
          await handlePosPaymentCreated({
            event: {
              name: "pos.payment.created",
              data: { id: payload.payment_id_to_emit },
            },
            container,
          } as any);
        }

        await new Promise((r) => setTimeout(r, 250));

        if (
          !payload.is_sales_receipt &&
          (payload.applications_to_emit?.length ?? 0) > 0
        ) {
          await Promise.all(
            payload.applications_to_emit.map(async (appPayload: any) => {
              await handlePosPaymentApplied({
                event: { name: "pos.payment.applied", data: appPayload },
                container,
              } as any);
            })
          );
        }
      } catch (dispatchErr: any) {
        logger.error(
          `[qb-invoice-waiting-gate] handler chain failed for invoice ${inv.id}: ${dispatchErr.message}`
        );
      }

      // Clear waiting flags — even if the handler chain errored, the pipeline
      // rows exist now and the regular retry cron will take over.
      await invoiceService.updatePosInvoices({
        id: inv.id,
        metadata: {
          ...meta,
          waiting_qb_items: false,
          waiting_variant_ids: null,
          qb_dispatch_payload: null,
          waiting_promoted_at: new Date().toISOString(),
        },
      });
      promoted++;
      logger.info(
        `[qb-invoice-waiting-gate] promoted invoice ${inv.id} (INV-${payload.invoice_number}) — all variants synced`
      );
    } catch (err: any) {
      logger.warn(
        `[qb-invoice-waiting-gate] invoice ${inv.id} failed: ${err.message}`
      );
    }
  }

  if (promoted || stillWaiting) {
    logger.info(
      `[qb-invoice-waiting-gate] tick: promoted=${promoted} stillWaiting=${stillWaiting} total=${waitingInvoices.length}`
    );
  }
}

export const config = {
  name: "qb-invoice-waiting-gate",
  schedule: "*/2 * * * *",
};
