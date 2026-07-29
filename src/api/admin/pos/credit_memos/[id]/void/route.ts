import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Modules } from "@medusajs/utils";

// 1.5.8: voidCreditMemoInQb import removed — route enqueues now.
import {
  writePipelineRow,
  findInFlightQbRowsByRef,
} from "../../../../../../lib/quickbooks/qb-pipeline";
import { CREDIT_MEMO_MODULE } from "../../../../../../modules/credit_memos";
import CreditMemoModuleService from "../../../../../../modules/credit_memos/service";
import { FINANCE_MODULE } from "../../../../../../modules/finance";
import { syncInventoryItemToMeiliSearchWorkflow } from "../../../../../../workflows/sync-inventory-item-meilisearch";
import { USA_LOC } from "../../../../../../lib/locations";

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const logger = req.scope.resolve("logger");
  const creditMemoService: CreditMemoModuleService =
    req.scope.resolve(CREDIT_MEMO_MODULE);
  const inventoryService = req.scope.resolve(Modules.INVENTORY);
  const stockLocationService = req.scope.resolve(Modules.STOCK_LOCATION);
  const financeService = req.scope.resolve(FINANCE_MODULE) as any;

  const { id } = req.params as { id: string };

  try {
    const creditMemo = (await creditMemoService.retrievePosCreditMemo(id, {
      relations: ["items"],
    })) as any;

    if (!creditMemo) {
      res.status(404).json({ message: "Credit Memo not found" });
      return;
    }

    if (creditMemo.status === "voided") {
      res.status(400).json({ message: "Credit Memo is already voided" });
      return;
    }

    const wasCompleted = creditMemo.status === "completed";

    // 1. Reverse inventory if CM was completed (items were restocked)
    const touchedInventoryItemIds = new Set<string>();
    if (wasCompleted) {
      // EXPLICIT Miami — never "first row" (with Miami + China Warehouse both
      // live, [0] could restock in China). Fail closed: no Miami → no restock.
      const allLocations = await stockLocationService.listStockLocations({
        id: USA_LOC,
      });
      const locationId = allLocations[0]?.id;
      if (!locationId) {
        console.warn(
          `[credit-memo] Miami location ${USA_LOC} not found — skipping restock`
        );
      }
      if (locationId) {
        for (const item of creditMemo.items) {
          if (!item.variant_id) continue;
          try {
            const query = req.scope.resolve("query");
            const { data } = await query.graph({
              entity: "product_variant",
              fields: [
                "id",
                "inventory_items.*",
                "inventory_items.inventory.id",
              ],
              filters: { id: item.variant_id },
            });
            const variant = data[0];
            const invItemId = variant?.inventory_items?.[0]?.inventory?.id;
            if (invItemId) {
              const levels = await inventoryService.listInventoryLevels({
                inventory_item_id: invItemId,
                location_id: locationId,
              });
              const firstLevel = levels?.[0];
              if (firstLevel) {
                // Only reverse what was actually restocked: complete/route.ts
                // adds (item.quantity - item.damaged_qty); void must mirror that.
                const restockableQty = Math.max(
                  0,
                  (item.quantity ?? 0) - (item.damaged_qty || 0)
                );
                const newQty = Math.max(
                  0,
                  (firstLevel.stocked_quantity ?? 0) - restockableQty
                );
                await inventoryService.updateInventoryLevels({
                  id: firstLevel.id,
                  inventory_item_id: invItemId,
                  location_id: locationId,
                  stocked_quantity: newQty,
                } as any);
                touchedInventoryItemIds.add(invItemId);
                logger.info(
                  `[void CM] Reversed inventory for variant ${item.variant_id}: -${item.quantity}`
                );
              }
            }
          } catch (invErr: any) {
            logger.warn(
              `[void CM] Could not reverse inventory for ${item.variant_id}: ${invErr.message}`
            );
          }
        }
      }
    }

    if (touchedInventoryItemIds.size > 0) {
      await Promise.allSettled(
        Array.from(touchedInventoryItemIds).map((inventoryItemId) =>
          syncInventoryItemToMeiliSearchWorkflow(req.scope).run({
            input: { inventoryItemId },
          })
        )
      );
    }

    // 2. Void associated customer_payment (credit_memo type)
    if (creditMemo.customer_id) {
      try {
        const pgConnection = req.scope.resolve("__pg_connection__") as any;
        const payRow = await pgConnection("customer_payment")
          .where({
            reference: creditMemo.credit_memo_number,
            type: "credit_memo",
          })
          .orWhere({ reference: creditMemo.credit_memo_number, type: "refund" })
          .whereNot({ status: "voided" })
          .first();

        if (payRow) {
          await financeService.updateCustomerPayments({
            id: payRow.id,
            status: "voided",
            metadata: {
              ...(payRow.metadata || {}),
              voided_via: "credit_memo_void",
              voided_at: new Date().toISOString(),
            },
          });
          logger.info(
            `[void CM] Voided customer_payment ${payRow.id} (${creditMemo.credit_memo_number})`
          );
        }
      } catch (payErr: any) {
        logger.warn(
          `[void CM] Could not void associated payment: ${payErr.message}`
        );
      }
    }

    // 3. Void in QuickBooks (if CM was synced)
    //
    // Si el ADD del credit memo sigue en vuelo todavía no hay TxnID que voidear.
    // NO se encadena con `depends_on`: la fila hija nacería sin `qb_txn_id` y
    // `runWakeDependentsPass` no lo copia del padre, así que despertaría para
    // morir en `resubmit-by-step` con "missing qb_txn_id — cannot void". Además
    // un padre `skipped`/`failed` no despierta a nadie nunca.
    //
    // La intención ya es durable (`pos_credit_memo.status='voided'`) y
    // `enqueueVoidIfAlreadyVoided` la materializa en el confirm del ADD, que es
    // el primer momento en que se conoce el TxnID. Acá sólo se deja rastro.
    if (wasCompleted && !creditMemo.qb_txn_id) {
      try {
        const inFlight = await findInFlightQbRowsByRef(id, "credit_memo", [
          "credit_memo",
        ]);
        if (inFlight.length > 0) {
          logger.info(
            `[void CM] ⏳ Void diferido — el create de ${creditMemo.credit_memo_number ?? id} sigue en vuelo ` +
              `(${inFlight.map((r: any) => `${r.step}:${r.status}`).join(", ")}); ` +
              `se materializará al confirmar el ADD (ver pipeline/void-intent.ts)`
          );
        }
      } catch (chainErr: any) {
        logger.warn(
          `[void CM] Could not check in-flight pipeline rows: ${chainErr.message}`
        );
      }
    }

    if (wasCompleted && creditMemo.qb_txn_id) {
      // 1.5.8: pipeline-only — enqueue 'pending' void_credit_memo with
      // qbTxnId set + editSequence in payload. Consolidator's case
      // 'void_credit_memo' calls voidCreditMemoInQb and transitions to
      // 'submitted'.
      try {
        await writePipelineRow({
          referenceId: id,
          referenceType: "credit_memo",
          step: "void_credit_memo",
          status: "pending",
          qbTxnId: creditMemo.qb_txn_id,
          qbRefNumber:
            creditMemo.qb_ref_number ?? creditMemo.credit_memo_number ?? null,
          medusaRefNumber: creditMemo.credit_memo_number ?? null,
          payload: {
            editSequence: creditMemo.qb_edit_sequence,
          },
        });
        logger.info(
          `[void CM] 📥 Enqueued void_credit_memo for ${creditMemo.qb_txn_id} (consolidator will submit)`
        );
      } catch (qbErr: any) {
        logger.warn(`[void CM] enqueue error (non-fatal): ${qbErr.message}`);
      }
    }

    // 4. Restore pos_invoice refund status + per-item refunded_quantity
    if ((creditMemo as any).order_id) {
      try {
        const invoiceService = req.scope.resolve("invoices") as any;
        const invoices = await invoiceService.listPosInvoices(
          { order_id: (creditMemo as any).order_id },
          { relations: ["items"], order: { issued_at: "DESC" } }
        );
        const invoice = invoices?.[0];
        if (invoice) {
          const cmTotal = Number((creditMemo as any).total ?? 0);
          const cmShipping = Number((creditMemo as any).shipping ?? 0);
          const prevRefunded = Number(invoice.refunded_amount ?? 0);
          const newRefunded = Math.max(0, prevRefunded - cmTotal);
          const newRefShip = Math.max(
            0,
            Number(invoice.refunded_shipping ?? 0) - cmShipping
          );
          const amountPaid = Number(invoice.amount_paid ?? 0);
          const invoiceTotal = Number(invoice.total ?? 0);

          let newStatus: string;
          if (newRefunded > 0) {
            newStatus =
              newRefunded >= invoiceTotal - 1
                ? "refunded"
                : "partially_refunded";
          } else {
            newStatus =
              amountPaid >= invoiceTotal - 1
                ? "paid"
                : amountPaid > 0
                  ? "partial"
                  : "issued";
          }

          await invoiceService.updatePosInvoices({
            id: invoice.id,
            refunded_amount: newRefunded,
            refunded_shipping: newRefShip,
            status: newStatus,
          });

          // Restore per-item refunded_quantity
          const invoiceItems: any[] = invoice.items ?? [];
          for (const cmItem of creditMemo.items) {
            const invItem = invoiceItems.find(
              (ii: any) => ii.sku && cmItem.sku && ii.sku === cmItem.sku
            );
            if (invItem) {
              const newQty = Math.max(
                0,
                (invItem.refunded_quantity ?? 0) - cmItem.quantity
              );
              await invoiceService.updatePosInvoiceItems({
                id: invItem.id,
                refunded_quantity: newQty,
              });
            }
          }

          logger.info(
            `[void CM] ✅ Invoice ${invoice.invoice_number} restored → ${newStatus}, refunded=${newRefunded}`
          );
        }
      } catch (invErr: any) {
        logger.warn(
          `[void CM] Could not restore invoice refund status (non-fatal): ${invErr.message}`
        );
      }
    }

    // 5. Mark CM as voided in DB
    await (creditMemoService as any).updatePosCreditMemos({
      id,
      status: "voided",
      voided_at: new Date(),
    });

    res.status(200).json({ success: true, message: "Credit Memo voided" });
  } catch (e: any) {
    logger.error(`[void CM] failed: ${e.message}`);
    res.status(500).json({ success: false, message: e.message });
  }
}
