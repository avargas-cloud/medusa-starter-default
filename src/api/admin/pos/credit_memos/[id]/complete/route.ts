import { randomUUID } from "crypto";

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Modules } from "@medusajs/utils";

// 1.5.8: createCreditMemoInQb import removed — route enqueues now.
import { parseSalesRepInitials } from "../../../../../../lib/quickbooks/parse-sales-rep";
import { getBusinessDateString } from "../../../../../../lib/quickbooks/order-flow-core";
import { getQbConfig } from "../../../../../../lib/quickbooks/qb-config";
import { resolveTaxListid } from "../../../../../../lib/quickbooks/resolve-tax-listid";
import {
  buildQbOrderDiscountLines,
  buildShippingQbItem,
} from "../../../../../../lib/quickbooks/order-flow-core";
import {
  writePipelineRow,
  requireQbCustomer,
} from "../../../../../../lib/quickbooks/qb-pipeline";
import { CREDIT_MEMO_MODULE } from "../../../../../../modules/credit_memos";
import CreditMemoModuleService from "../../../../../../modules/credit_memos/service";
import { FINANCE_MODULE } from "../../../../../../modules/finance";
import { syncInventoryItemToMeiliSearchWorkflow } from "../../../../../../workflows/sync-inventory-item-meilisearch";
import { assertWebOrdersAuthorized } from "../../../../orders/[id]/_lib/assert-web-order-authorized";
import { USA_LOC } from "../../../../../../lib/locations";
import { syncCreditMemoDamageAdjustment } from "../../../../../../lib/quickbooks/damage/sync-damage-adjustment";

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

    // Credit memo de una orden WEB → PIN de supervisor: completar/editar/
    // voidear una devolución mueve dinero e inventario del contrato que el
    // cliente armó solo. Corre ANTES de toda mutación.
    const webGate = await assertWebOrdersAuthorized(
      req.scope,
      [creditMemo.order_id as string | undefined],
      req
    );
    if (webGate.denial) {
      res.status(webGate.denial.status).json(webGate.denial.body);
      return;
    }

    if (creditMemo.status !== "created") {
      res
        .status(400)
        .json({ message: "Credit Memo is already completed or voided" });
      return;
    }

    // Cashier's choice at Complete time — persisted so the UI can always
    // show which option was picked, and drives the refund mirror path below.
    const { refund_method: refundMethodBody } = req.body as {
      refund_method?: string;
    };
    const refundMethod: "store_credit" | "refund" =
      refundMethodBody === "refund" ? "refund" : "store_credit";
    const isRefund = refundMethod === "refund";

    // Lock immediately to prevent duplicate completions from concurrent requests
    // (QB sync can take 1-2 min; without this, a second click passes the guard above)
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
      refund_method: refundMethod,
    });

    // Restock Inventory for every variant in the credit memo
    // Use the first active stock location (no assumption on name)
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
    const touchedInventoryItemIds = new Set<string>();

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
                  touchedInventoryItemIds.add(invItemId);
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

    if (touchedInventoryItemIds.size > 0) {
      await Promise.allSettled(
        Array.from(touchedInventoryItemIds).map((inventoryItemId) =>
          syncInventoryItemToMeiliSearchWorkflow(req.scope).run({
            input: { inventoryItemId },
          })
        )
      );
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

    // -- QB INVENTORY ADJUSTMENT (defectuosos) --
    // Las unidades defectuosas no volvieron a stock en Medusa, pero el credit
    // memo que va a QuickBooks las acredita igual — QB no tiene el concepto.
    // Sin este ajuste, QuickBooks sobreestima el inventario una unidad por cada
    // defectuoso. No tira: la plata ya se movió.
    await syncCreditMemoDamageAdjustment({
      creditMemoId: id,
      reason: "complete",
      logger,
    });

    // -- QUICKBOOKS SYNC BEGIN --
    // 1.5.8: qbOperationId no longer tracked here — consolidator owns the
    // submission lifecycle. We just enqueue and return.
    try {
      if (creditMemo.customer_id) {
        // Preflight: if customer has no qb_list_id, enqueue customer pipeline row
        // and mark credit_memo row as waiting with depends_on. Consolidator will
        // create the customer and wake the credit_memo row automatically.
        const check = await requireQbCustomer({
          customerId: creditMemo.customer_id,
          step: "credit_memo",
          selfReferenceId: id,
          selfReferenceType: "credit_memo",
          selfMedusaRefNumber: creditMemo.credit_memo_number ?? null,
        });

        if ("waiting" in check) {
          logger.info(
            `[credit_memos complete] ⏸ Waiting on customer ${creditMemo.customer_id} (customer row ${check.customerRowId}) before submitting Credit Memo`
          );
        } else {
          const qbCustomerId = check.qbListId;

          // Map items for QB Payload.
          // unit_price is stored in cents → divide by 100 for QB dollars.
          // productId is intentionally omitted — we use FullName (SKU) so QB
          // can resolve the item without needing its internal ListID.
          //
          // Service / non-inventory items (Adjustment lines, QB service products)
          // must NOT carry InventorySiteRef (QB error 3140). We flag them with
          // noSite: true so the bridge skips the Site tag.
          const variantIds: string[] = creditMemo.items
            .map((i: any) => i.variant_id)
            .filter((id: any): id is string => !!id);

          const variants: any[] = variantIds.length
            ? await (req.scope.resolve("__pg_connection__") as any)
                .raw(
                  `SELECT pv.id,
                          COALESCE(pv.metadata, '{}'::jsonb) AS variant_metadata,
                          COALESCE(p.metadata, '{}'::jsonb) AS product_metadata
                     FROM product_variant pv
                     LEFT JOIN product p ON p.id = pv.product_id
                    WHERE pv.id = ANY(?::text[])`,
                  [variantIds]
                )
                .then((r: any) => r.rows ?? [])
                .catch(() => [])
            : [];
          const variantInfoMap = new Map<string, any>(
            variants.map((v) => [
              v.id,
              {
                variantMetadata: v.variant_metadata || {},
                productMetadata: v.product_metadata || {},
              },
            ])
          );

          const NON_INVENTORY_QB_TYPES = new Set([
            "Service",
            "NonInventory",
            "NonInventoryPart",
            "OtherCharge",
            "Discount",
          ]);
          const qbItems = creditMemo.items
            .filter((item: any) => Number(item.quantity ?? 0) > 0)
            .map((item: any) => {
              const unitPriceDollars = (item.unit_price || 0) / 100;
              const info = item.variant_id
                ? variantInfoMap.get(item.variant_id)
                : null;
              const meta = info?.variantMetadata || {};
              const productMeta = info?.productMetadata || {};
              const qbListId = meta?.quickbooks_id as string | undefined;
              const qbItemType =
                meta?.qb_item_type ?? productMeta?.qb_item_type;
              const isService = !!(
                !item.variant_id ||
                meta?.quickbooks_is_service === true ||
                meta?.quickbooks_is_service === "true" ||
                meta?.quickbooks_no_site === true ||
                meta?.quickbooks_no_site === "true" ||
                productMeta?.quickbooks_is_service === true ||
                productMeta?.quickbooks_is_service === "true" ||
                productMeta?.quickbooks_no_site === true ||
                productMeta?.quickbooks_no_site === "true" ||
                (typeof qbItemType === "string" &&
                  NON_INVENTORY_QB_TYPES.has(qbItemType))
              );
              return {
                // Prefer ListID (stable) over FullName (SKU can be renamed in Medusa)
                ...(qbListId ? { productId: qbListId } : {}),
                productName: item.sku || item.title,
                quantity: item.quantity,
                price: unitPriceDollars,
                amount: Number((unitPriceDollars * item.quantity).toFixed(2)),
                desc: item.description || item.title,
                ...(typeof qbItemType === "string" ? { qbItemType } : {}),
                ...(isService ? { noSite: true } : {}),
                ...(isService ? { taxable: false } : {}),
              };
            });

          if (qbItems.length === 0) {
            throw new Error(
              `Skipping QB sync for ${id}: no positive-quantity return lines`
            );
          }

          // A return's tax mode belongs to the CM itself. Do not inherit tax
          // from the parent invoice, since partial returns can be tax-exempt.
          const isTaxExempt =
            Number(creditMemo.tax ?? 0) === 0 &&
            Number(creditMemo.subtotal ?? 0) > 0;

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
          const qbConfig = await getQbConfig();
          const cmSalesTaxCode = isTaxExempt
            ? qbConfig.exemptSalesTaxCode
            : qbConfig.defaultSalesTaxCode;
          const qbTaxItemListid = resolveTaxListid(
            isTaxExempt ? "exempt" : "florida",
            qbConfig
          );
          const salesRepRef = parseSalesRepInitials(
            (creditMemo as any).sales_rep
          );

          // 1.5.8: pipeline-only — enqueue 'pending' credit_memo with full
          // payload. Consolidator's case 'credit_memo' calls
          // createCreditMemoInQb and transitions to 'submitted'.
          try {
            await writePipelineRow({
              referenceId: id,
              referenceType: "credit_memo",
              step: "credit_memo",
              status: "pending",
              medusaRefNumber: creditMemo.credit_memo_number ?? null,
              qbRefNumber: creditMemo.credit_memo_number ?? null,
              payload: {
                customerId: qbCustomerId,
                date: getBusinessDateString(
                  (creditMemo as any).created_at ?? null
                ),
                memo: `POS Return ${creditMemo.credit_memo_number || ""}`.trim(),
                items: qbItems,
                salesTaxCode: cmSalesTaxCode,
                ...(qbTaxItemListid ? { qbTaxItemListid } : {}),
                ...(isTaxExempt ? { taxExempt: true } : {}),
                ...(salesRepRef ? { salesRepRef } : {}),
              },
            });
            logger.info(
              `[credit_memos complete] 📥 Enqueued credit_memo for ${id} (consolidator will submit)`
            );
          } catch (pErr: any) {
            logger.warn(
              `[credit_memos complete] Could not write pipeline row: ${pErr.message}`
            );
          }
        }
      }
    } catch (qbErr: any) {
      logger.error(
        `[credit_memos complete] QuickBooks sync execution error: ${qbErr.message}`
      );
    }
    // -- QUICKBOOKS SYNC END --

    // -- AR LEDGER SYNC BEGIN --
    // The finance-ledger entry is ALWAYS created the same way (type=credit_memo,
    // method=credit_memo, status=available). The difference between 'store_credit'
    // and 'refund' only matters at the extra step after: for refund, we mark the
    // freshly-created payment as refunded so it lands in accounting's queue to be
    // physically processed — and we issue a QB Write Check against AR.
    const cmTotal =
      (creditMemo as any).total ||
      (creditMemo as any).subtotal ||
      creditMemo.items.reduce(
        (sum: number, i: any) => sum + i.quantity * i.unit_price,
        0
      );

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
          // Only flip invoice status when the cashier explicitly chose
          // "refund" (cash/card back). For "store_credit" the invoice stays
          // paid — the customer received a credit, not a refund. Per canonical
          // CM flow: status flips to refunded only via explicit refund path.
          const invoiceTotal = Number(invoice.total ?? 0);
          const newStatus = isRefund
            ? newRefunded >= invoiceTotal - 1
              ? "refunded"
              : "partially_refunded"
            : invoice.status;

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

        // Secondary idempotency guard: skip if a payment for this CM already exists
        const existingPayments = await financeService.listCustomerPayments(
          { reference: cmRef, customer_id: creditMemo.customer_id },
          { take: 1 }
        );
        if (existingPayments?.length > 0) {
          logger.warn(
            `[credit_memos complete] Payment for ${cmRef} already exists (id=${existingPayments[0].id}) — skipping duplicate`
          );
        } else {
          const createdPayment = (await financeService.createCustomerPayments({
            customer_id: creditMemo.customer_id,
            display_id: nextPayNum,
            amount: cmTotal,
            method: "credit_memo",
            reference: cmRef,
            notes: `Store Credit generated from Return/Credit Memo`,
            received_at: new Date(),
            created_by: "system",
            source: "pos",
            type: "credit_memo",
            status: "available",
            medusa_payment_synced: false,
          })) as any;

          logger.info(
            `[credit_memos complete] Registered $${cmTotal} as credit_memo for customer ${creditMemo.customer_id} (refund_method=${refundMethod})`
          );

          // -- REFUND PATH BEGIN --
          // Cashier chose Refund → flip the freshly-created payment to
          // 'refunded' so it surfaces in the accounting Pending QB Refunds
          // queue. The physical QB Write Check + apply-payment is initiated
          // manually by administration from /accounting → POST
          // /admin/finance/qb-refunds/sync. We intentionally do NOT pre-emit
          // the Write Check here to avoid duplicate checks (that route writes
          // its own pipeline rows indexed by customer_payment_id).
          if (isRefund) {
            try {
              const refundMeta = {
                refund_amount: Number(cmTotal),
                refunded_at: new Date().toISOString(),
                refund_notes: `Triggered by CM ${creditMemo.credit_memo_number ?? ""} completion`,
                refunded_by: "system",
              };
              await pgConnection.raw(
                `UPDATE customer_payment
                   SET status = 'refunded', metadata = ?::jsonb
                   WHERE id = ?`,
                [JSON.stringify(refundMeta), createdPayment.id]
              );
              logger.info(
                `[credit_memos complete] Flipped payment ${createdPayment.id} → refunded for CM ${cmRef} (accounting will process QB Write Check)`
              );
            } catch (flipErr: any) {
              logger.error(
                `[credit_memos complete] Could not mark payment as refunded: ${flipErr.message}`
              );
            }
          }
          // -- REFUND PATH END --
        }
      } catch (finErr: any) {
        logger.error(
          `[credit_memos complete] Failed to create Finance Ledger record: ${finErr.message}`
        );
      }
    }
    // -- AR LEDGER SYNC END --

    res.status(200).json({
      success: true,
      message: "Credit Memo completed and inventory restocked",
    });
  } catch (e: any) {
    logger.error(`[credit_memos complete] failed: ${e.message}`);
    res.status(500).json({ success: false, message: e.message });
  }
}
