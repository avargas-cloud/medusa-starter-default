import { randomUUID } from "crypto";
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { CREDIT_MEMO_MODULE } from "../../../../../../modules/credit_memos";
import CreditMemoModuleService from "../../../../../../modules/credit_memos/service";
import { Modules } from "@medusajs/utils";
import {
  createCreditMemoInQb,
  createCheckInQb,
} from "../../../../../../lib/quickbooks/client";
import {
  ensureCustomerInQb,
  buildQbOrderDiscountLines,
  buildShippingQbItem,
} from "../../../../../../lib/quickbooks/order-flow-core";
import { FINANCE_MODULE } from "../../../../../../modules/finance";
import { writePipelineRow } from "../../../../../../lib/quickbooks/qb-pipeline";

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const logger = req.scope.resolve("logger");
  const creditMemoService: CreditMemoModuleService =
    req.scope.resolve(CREDIT_MEMO_MODULE);
  const inventoryService = req.scope.resolve(Modules.INVENTORY);
  const stockLocationService = req.scope.resolve(Modules.STOCK_LOCATION);
  const customerModule = req.scope.resolve(Modules.CUSTOMER);
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

    if (creditMemo.status !== "created") {
      res
        .status(400)
        .json({ message: "Credit Memo is already completed or voided" });
      return;
    }

    // Restock Inventory for every variant in the credit memo
    // Use the first active stock location (no assumption on name)
    const allLocations = await stockLocationService.listStockLocations({});
    const locationId = allLocations[0]?.id;

    if (locationId) {
      for (const item of creditMemo.items) {
        if (!item.variant_id) continue;

        try {
          const query = req.scope.resolve("query");
          const { data } = await query.graph({
            entity: "product_variant",
            fields: ["id", "inventory_items.*", "inventory_items.inventory.id"],
            filters: { id: item.variant_id },
          });

          const variant = data[0];
          if (
            variant &&
            variant.inventory_items &&
            variant.inventory_items.length > 0
          ) {
            const invItemId = variant.inventory_items[0]?.inventory?.id;

            // Fetch current level
            if (invItemId) {
              const levels = await inventoryService.listInventoryLevels({
                inventory_item_id: invItemId,
                location_id: locationId,
              });

              if (levels && levels.length > 0) {
                // Only restock non-damaged units
                const damagedQty = item.damaged_qty || 0;
                const restockQty = item.quantity - damagedQty;
                if (restockQty > 0) {
                  const newQty =
                    (levels[0]?.stocked_quantity || 0) + restockQty;
                  await inventoryService.updateInventoryLevels({
                    id: levels[0]?.id as string,
                    inventory_item_id: invItemId,
                    location_id: locationId,
                    stocked_quantity: newQty,
                  } as any);
                  logger.info(
                    `Restocked inventory for variant ${item.variant_id}: +${restockQty} (${damagedQty} damaged, not restocked)`
                  );
                } else {
                  logger.info(
                    `Skipped restock for variant ${item.variant_id}: all ${item.quantity} units are damaged`
                  );
                }
              }
            }
          }
        } catch (invErr: any) {
          logger.warn(
            `Failed to restock inventory for variant ${item.variant_id}: ${invErr.message}`
          );
        }
      }
    }

    // -- DAMAGED ITEMS TRACKING BEGIN --
    // Insert a row in pos_damaged_item for every item that has damaged_qty > 0.
    // These units were NOT restocked to inventory.
    try {
      const pgConnection = req.scope.resolve("__pg_connection__") as any;
      const damagedRows = creditMemo.items
        .filter((item: any) => (item.damaged_qty || 0) > 0)
        .map((item: any) => ({
          id: randomUUID(),
          credit_memo_id: id,
          order_id: (creditMemo as any).order_id || null,
          variant_id: item.variant_id || null,
          sku: item.sku || null,
          title: item.title || null,
          quantity: item.damaged_qty,
          unit_price: item.unit_price || 0,
          created_at: new Date(),
        }));

      if (damagedRows.length > 0) {
        await pgConnection("pos_damaged_item").insert(damagedRows);
        logger.info(
          `[credit_memos complete] Logged ${damagedRows.length} damaged item record(s)`
        );
      }
    } catch (dmgErr: any) {
      logger.warn(
        `[credit_memos complete] Could not log damaged items (non-fatal): ${dmgErr.message}`
      );
    }
    // -- DAMAGED ITEMS TRACKING END --

    // -- QUICKBOOKS SYNC BEGIN --
    let qbOperationId = null;
    let custResult: any = null;
    try {
      if (creditMemo.customer_id) {
        // Ensure customer in QB
        const customer = await customerModule.retrieveCustomer(
          creditMemo.customer_id,
          { relations: ["addresses"] }
        );
        custResult = await ensureCustomerInQb(
          customer,
          customerModule,
          (m: string) => logger.info(m)
        );

        if (custResult.success && custResult.qbCustomerId) {
          const qbCustomerId = custResult.qbCustomerId;

          // Map items for QB Payload.
          // unit_price is stored in cents → divide by 100 for QB dollars.
          // productId is intentionally omitted — we use FullName (SKU) so QB
          // can resolve the item without needing its internal ListID.
          const qbItems = creditMemo.items.map((item: any) => {
            const unitPriceDollars = (item.unit_price || 0) / 100;
            return {
              productName: item.sku || item.title,
              quantity: item.quantity,
              price: unitPriceDollars,
              amount: Number((unitPriceDollars * item.quantity).toFixed(2)),
              desc: item.description || item.title,
            };
          });

          // Add order-level discount lines (Subtotal + Discount QB items)
          if (creditMemo.discount > 0) {
            const discountDollars = creditMemo.discount / 100;
            buildQbOrderDiscountLines(discountDollars).forEach((l: any) =>
              qbItems.push(l)
            );
          }

          // Add shipping line if applicable
          if (creditMemo.shipping > 0) {
            const shippingDollars = creditMemo.shipping / 100;
            const shippingItem = buildShippingQbItem([
              {
                amount: shippingDollars,
                name: creditMemo.shipping_option_name || "Shipping",
              },
            ]);
            if (shippingItem) qbItems.push(shippingItem);
          }

          logger.info(
            `[credit_memos complete] Mirroring Credit Memo to QB for customer ${qbCustomerId}...`
          );
          const cmResult = await createCreditMemoInQb({
            customerId: qbCustomerId,
            refNumber: creditMemo.credit_memo_number || undefined,
            date: new Date().toISOString().split("T")[0],
            memo: `POS Return ${creditMemo.credit_memo_number || ""}`.trim(),
            items: qbItems,
          });

          if (cmResult.success && cmResult.data?.operationId) {
            qbOperationId = cmResult.data.operationId;
            logger.info(
              `[credit_memos complete] QB Sync queued: ${qbOperationId}`
            );

            // Record credit_memo step in pipeline
            try {
              await writePipelineRow({
                referenceId: id,
                referenceType: "credit_memo",
                step: "credit_memo",
                status: "submitted",
                bridgeOpId: qbOperationId,
                medusaRefNumber: creditMemo.credit_memo_number ?? null,
                qbRefNumber: creditMemo.credit_memo_number ?? null,
              });
            } catch (pErr: any) {
              logger.warn(
                `[credit_memos complete] Could not write pipeline row: ${pErr.message}`
              );
            }
          } else {
            logger.error(
              `[credit_memos complete] QB Sync failed: ${cmResult.error}`
            );

            // Record failure in pipeline
            try {
              await writePipelineRow({
                referenceId: id,
                referenceType: "credit_memo",
                step: "credit_memo",
                status: "failed",
                error: cmResult.error || "QB credit memo creation failed",
              });
            } catch (pErr: any) {
              logger.warn(
                `[credit_memos complete] Could not write pipeline row: ${pErr.message}`
              );
            }
          }
        }
      }
    } catch (qbErr: any) {
      logger.error(
        `[credit_memos complete] QuickBooks sync execution error: ${qbErr.message}`
      );
    }
    // -- QUICKBOOKS SYNC END --

    // Mark Credit Memo as completed — discover method name at runtime
    const updateMethodName =
      typeof (creditMemoService as any).updatePosCreditMemos === "function"
        ? "updatePosCreditMemos"
        : typeof (creditMemoService as any).updatePosCreditMemoes === "function"
          ? "updatePosCreditMemoes"
          : Object.keys(creditMemoService as any).find(
              (k) =>
                k.startsWith("update") && k.toLowerCase().includes("credit")
            );
    if (!updateMethodName)
      throw new Error("Cannot find updatePosCreditMemo* method on service");
    await (creditMemoService as any)[updateMethodName]({
      id,
      status: "completed",
      completed_at: new Date(),
    });

    // -- AR LEDGER SYNC BEGIN --
    // Register a Finance Ledger entry based on the chosen refund method:
    //   store_credit → type:'credit_memo', status:'available'  (credit for future purchases)
    //   refund       → type:'refund',      status:'applied'    (physical refund done by staff)
    const { refund_method } = req.body as { refund_method?: string };
    const isStoreCredit = !refund_method || refund_method === "store_credit";

    // Compute CM total once — used for both native Medusa refund and Finance Ledger
    const cmTotal =
      (creditMemo as any).total ||
      (creditMemo as any).subtotal ||
      creditMemo.items.reduce(
        (sum: number, i: any) => sum + i.quantity * i.unit_price,
        0
      );

    // -- NATIVE MEDUSA REFUND BEGIN --
    // If the parent order has a Medusa payment_collection (created by registerMedusaPayment
    // during Sales Receipt / Invoice flow), issue a native refund so Medusa tracks it properly.
    if ((creditMemo as any).order_id) {
      try {
        const MODULE_PAYMENT = "payment";
        const query = req.scope.resolve("query");
        const {
          data: [orderData],
        } = await query.graph({
          entity: "order",
          fields: [
            "payment_collections.payments.id",
            "payment_collections.payments.captures.*",
            "payment_collections.payments.refunds.*",
          ],
          filters: { id: (creditMemo as any).order_id },
        });
        const payments = (orderData?.payment_collections ?? []).flatMap(
          (pc: any) => pc.payments ?? []
        );
        const refundAmountDollars = cmTotal / 100; // cmTotal is in cents

        for (const payment of payments) {
          const captured = (payment.captures ?? []).reduce(
            (s: number, c: any) => s + Number(c.amount),
            0
          );
          const refunded = (payment.refunds ?? []).reduce(
            (s: number, r: any) => s + Number(r.amount),
            0
          );
          const available = captured - refunded;

          if (available >= refundAmountDollars - 0.001) {
            const paymentModule = req.scope.resolve(MODULE_PAYMENT);
            await paymentModule.refundPayment({
              payment_id: payment.id,
              amount: refundAmountDollars,
            });
            logger.info(
              `[credit_memos complete] ✅ Native Medusa refund: $${refundAmountDollars.toFixed(2)} on payment ${payment.id}`
            );
            break;
          }
        }
      } catch (refundErr: any) {
        logger.warn(
          `[credit_memos complete] Native Medusa refund failed (non-fatal): ${refundErr.message}`
        );
      }
    }
    // -- NATIVE MEDUSA REFUND END --

    // -- POS INVOICE REFUND STATUS BEGIN --
    // Update the parent pos_invoice: status, refunded_amount, refunded_shipping,
    // and per-item refunded_quantity (for max-quantity enforcement on future CMs).
    if ((creditMemo as any).order_id) {
      try {
        const invoiceService = req.scope.resolve("invoices") as any;
        const invoices = await invoiceService.listPosInvoices(
          { order_id: (creditMemo as any).order_id },
          { relations: ["items"], order: { issued_at: "DESC" } }
        );
        const invoice = invoices?.[0];
        if (invoice) {
          // 1. Update refunded_amount + refunded_shipping on the invoice
          const cmShipping = Number((creditMemo as any).shipping ?? 0);
          const prevRefunded = Number(invoice.refunded_amount ?? 0);
          const newRefunded = prevRefunded + cmTotal;
          const newRefShip =
            Number(invoice.refunded_shipping ?? 0) + cmShipping;
          const invoiceTotal = Number(invoice.total ?? 0);
          const newStatus =
            newRefunded >= invoiceTotal - 1 ? "refunded" : "partially_refunded";

          await invoiceService.updatePosInvoices({
            id: invoice.id,
            refunded_amount: newRefunded,
            refunded_shipping: newRefShip,
            status: newStatus,
          });

          // 2. Update refunded_quantity per item (matched by sku)
          const invoiceItems: any[] = invoice.items ?? [];
          for (const cmItem of creditMemo.items) {
            const invItem = invoiceItems.find(
              (ii: any) => ii.sku && cmItem.sku && ii.sku === cmItem.sku
            );
            if (invItem) {
              const newQty = (invItem.refunded_quantity ?? 0) + cmItem.quantity;
              await invoiceService.updatePosInvoiceItems({
                id: invItem.id,
                refunded_quantity: Math.min(newQty, invItem.quantity),
              });
            }
          }

          logger.info(
            `[credit_memos complete] ✅ Invoice ${invoice.invoice_number} → ${newStatus}, refunded=${newRefunded}, ship_refunded=${newRefShip}`
          );
        }
      } catch (invErr: any) {
        logger.warn(
          `[credit_memos complete] Could not update invoice refund status (non-fatal): ${invErr.message}`
        );
      }
    }
    // -- POS INVOICE REFUND STATUS END --

    if (creditMemo.customer_id) {
      try {
        const pgConnection = req.scope.resolve("__pg_connection__") as any;
        const seqPgRes = await pgConnection
          .raw(`SELECT nextval('custom_payment_seq') AS seq`)
          .catch(() => ({ rows: [{ seq: null }] }));
        const nextPayNum =
          seqPgRes.rows[0]?.seq || seqPgRes.rows[0]?.SEQ
            ? Number(seqPgRes.rows[0].seq || seqPgRes.rows[0].SEQ)
            : null;

        const cmRef =
          creditMemo.credit_memo_number ?? `CM-${creditMemo.id.slice(-6)}`;

        await financeService.createCustomerPayments({
          customer_id: creditMemo.customer_id,
          display_id: nextPayNum,
          amount: cmTotal,
          method: isStoreCredit ? "credit_memo" : "refund",
          reference: cmRef,
          notes: isStoreCredit
            ? `Store Credit generated from Return/Credit Memo`
            : `Refund — to be processed manually by staff`,
          received_at: new Date(),
          created_by: "system",
          source: "pos",
          type: isStoreCredit ? "credit_memo" : "refund",
          status: isStoreCredit ? "available" : "applied",
          medusa_payment_synced: false,
        });

        logger.info(
          `[credit_memos complete] Registered $${cmTotal} as '${isStoreCredit ? "store_credit" : "refund"}' ` +
            `in Finance Ledger for customer ${creditMemo.customer_id}`
        );

        // If this is a physical cash refund → create Write Check in QB
        if (!isStoreCredit && custResult?.qbCustomerId) {
          const bankAccountListId = process.env.QB_BANK_ACCOUNT_LIST_ID;
          if (!bankAccountListId) {
            logger.warn(
              `[credit_memos complete] QB_BANK_ACCOUNT_LIST_ID not set — skipping Write Check`
            );
          } else {
            try {
              // Record as pending before calling bridge
              await writePipelineRow({
                referenceId: id,
                referenceType: "credit_memo",
                step: "write_check",
                status: "pending",
                medusaRefNumber: creditMemo.credit_memo_number ?? null,
                error: null,
              });

              const checkResult = await createCheckInQb({
                customerId: custResult.qbCustomerId,
                bankAccountListId,
                amount: cmTotal / 100,
                date: new Date().toISOString().split("T")[0],
                refNumber: `CM-${creditMemo.credit_memo_number || id.slice(-6)}`,
                memo: `Refund for CM ${creditMemo.credit_memo_number || ""}`.trim(),
                expenseAccountName: "Accounts Receivable",
              });

              if (checkResult.success && checkResult.data?.operationId) {
                await writePipelineRow({
                  referenceId: id,
                  referenceType: "credit_memo",
                  step: "write_check",
                  status: "submitted",
                  bridgeOpId: checkResult.data.operationId,
                  medusaRefNumber: creditMemo.credit_memo_number ?? null,
                });
                logger.info(
                  `[credit_memos complete] Write Check queued in QB: op=${checkResult.data.operationId}`
                );
              } else {
                await writePipelineRow({
                  referenceId: id,
                  referenceType: "credit_memo",
                  step: "write_check",
                  status: "failed",
                  error: checkResult.error || "Write Check creation failed",
                });
                logger.error(
                  `[credit_memos complete] Write Check failed: ${checkResult.error}`
                );
              }
            } catch (checkErr: any) {
              logger.error(
                `[credit_memos complete] Write Check execution error: ${checkErr.message}`
              );
            }
          }
        }
      } catch (finErr: any) {
        logger.error(
          `[credit_memos complete] Failed to create Finance Ledger record: ${finErr.message}`
        );
      }
    }
    // -- AR LEDGER SYNC END --

    res
      .status(200)
      .json({
        success: true,
        message: "Credit Memo completed and inventory restocked",
      });
  } catch (e: any) {
    logger.error(`[credit_memos complete] failed: ${e.message}`);
    res.status(500).json({ success: false, message: e.message });
  }
}
