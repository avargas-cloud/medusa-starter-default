import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Modules } from "@medusajs/utils";

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
import {
  CM_SYNTHETIC_LINE_IDS_META_KEY,
  applyQbSyntheticLineIds,
  readQbSyntheticLineIds,
} from "../../../../../../lib/quickbooks/credit-memo-synthetic-lines";
import { getVariantAvgCostBatch } from "../../../../../../lib/cost/get-variant-avg-cost";
import { CREDIT_MEMO_MODULE } from "../../../../../../modules/credit_memos";
import CreditMemoModuleService from "../../../../../../modules/credit_memos/service";
import { syncInventoryItemToMeiliSearchWorkflow } from "../../../../../../workflows/sync-inventory-item-meilisearch";
import { USA_LOC } from "../../../../../../lib/locations";

const NON_INVENTORY_QB_TYPES = new Set([
  "Service",
  "NonInventory",
  "NonInventoryPart",
  "OtherCharge",
  "Discount",
]);

/**
 * PATCH /admin/pos/credit_memos/:id/edit
 *
 * PIN-protected edit of a completed credit memo.
 * - Adjusts inventory levels by delta (new restockable − old restockable per variant)
 * - Updates customer_payment amount (guarded: cannot reduce below already-applied credit)
 * - Updates parent invoice refunded amounts + per-item refunded_quantity
 * - Replaces CM items in DB
 * - Voids old QB credit memo + enqueues a fresh one
 */
export async function PATCH(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const logger = req.scope.resolve("logger");
  const creditMemoService =
    req.scope.resolve<CreditMemoModuleService>(CREDIT_MEMO_MODULE);
  const inventoryService = req.scope.resolve(Modules.INVENTORY);
  const stockLocationService = req.scope.resolve(Modules.STOCK_LOCATION);
  const pgConnection = req.scope.resolve("__pg_connection__") as any;

  const { id } = req.params as { id: string };

  try {
    const creditMemo = (await creditMemoService.retrievePosCreditMemo(id, {
      relations: ["items"],
    })) as any;

    if (!creditMemo) {
      res.status(404).json({ message: "Credit Memo not found" });
      return;
    }

    if (creditMemo.status !== "completed") {
      res
        .status(400)
        .json({ message: "Only completed credit memos can be edited" });
      return;
    }

    const {
      payload,
      items: newItems,
      totals,
      shipping,
    } = req.body as {
      payload?: {
        customer_id?: string;
        notes?: string;
        sales_rep?: { initials: string; name: string } | null;
        invoice_id?: string | null;
        order_id?: string | null;
        metadata?: Record<string, unknown> | null;
      };
      items?: Array<{
        variantId?: string | null;
        sku?: string | null;
        title: string;
        salesDescription?: string;
        quantity: number;
        damagedQty?: number;
        effectiveUnitPrice?: number;
        unitPrice: number;
        thumbnail?: string | null;
      }>;
      totals?: {
        subtotal?: number;
        totalDiscount?: number;
        tax?: number;
        shipping?: number;
        total?: number;
      };
      shipping?: { optionId?: string; optionName?: string } | null;
    };

    if (!newItems || newItems.length === 0) {
      res.status(400).json({ message: "At least one item is required" });
      return;
    }

    const dbTotals = {
      subtotal: Math.round((totals?.subtotal ?? 0) * 100),
      discount: Math.round((totals?.totalDiscount ?? 0) * 100),
      tax: Math.round((totals?.tax ?? 0) * 100),
      shipping: Math.round((totals?.shipping ?? 0) * 100),
      total: Math.round((totals?.total ?? 0) * 100),
    };

    // ── Payment guard: cannot reduce below already-applied credit ─────────────
    const cmNumber = creditMemo.credit_memo_number as string | null | undefined;
    if (cmNumber) {
      const payment = await pgConnection("customer_payment")
        .where({ reference: cmNumber, type: "credit_memo" })
        .whereNull("deleted_at")
        .first()
        .catch(() => null);

      if (payment) {
        const applyRow = await pgConnection("payment_application")
          .where({ payment_id: payment.id })
          .whereNull("voided_at")
          .whereNull("deleted_at")
          .sum("amount_applied as total")
          .first()
          .catch(() => null);

        const appliedTotal = Number(applyRow?.total ?? 0);
        const oldTotal = Number((creditMemo as any).total ?? 0);
        // If any credit has been applied, the new total cannot be less than
        // the current total (since the applied portion is already consumed).
        if (appliedTotal > 0 && dbTotals.total < oldTotal) {
          const appliedDollars = (appliedTotal / 100).toFixed(2);
          res.status(409).json({
            error: `Cannot reduce credit memo: $${appliedDollars} has already been applied. You can only increase the total when credit has been used.`,
          });
          return;
        }
        // Also block if the new total would be less than what was applied
        if (dbTotals.total < appliedTotal) {
          const appliedDollars = (appliedTotal / 100).toFixed(2);
          res.status(409).json({
            error: `Cannot reduce credit below $${appliedDollars} already applied to invoices. Reverse those applications first.`,
          });
          return;
        }
      }
    }

    // ── Per-item quantity guard: new_qty ≤ invoiced − refunded_in_other_CMs ────
    // For each SKU on the new payload, ensure it does not exceed what's still
    // available to refund on the parent invoice. The current
    // pos_invoice_item.refunded_quantity reflects ALL credit memos (including
    // this one), so we subtract this CM's old contribution to get
    // refunded_by_others, then enforce new_qty ≤ invoiced − refunded_by_others.
    // SKUs not present on the parent invoice are blocked unless they were
    // already in this CM (preserves legacy state, blocks new fabrications).
    if (creditMemo.order_id) {
      try {
        const invoiceService = req.scope.resolve("invoices") as any;
        const invoices = await invoiceService.listPosInvoices(
          { order_id: creditMemo.order_id },
          { relations: ["items"], order: { issued_at: "DESC" } }
        );
        const parentInvoice = invoices?.[0];
        if (parentInvoice) {
          const oldQtyBySku = new Map<string, number>();
          for (const item of creditMemo.items as any[]) {
            if (!item.sku) continue;
            oldQtyBySku.set(
              item.sku,
              (oldQtyBySku.get(item.sku) ?? 0) + Number(item.quantity ?? 0)
            );
          }
          const newQtyBySku = new Map<string, number>();
          for (const item of newItems) {
            if (!item.sku) continue;
            newQtyBySku.set(
              item.sku,
              (newQtyBySku.get(item.sku) ?? 0) + Number(item.quantity ?? 0)
            );
          }
          const invoiceItemBySku = new Map<string, any>();
          for (const invItem of (parentInvoice.items as any[]) ?? []) {
            if (!invItem.sku) continue;
            invoiceItemBySku.set(invItem.sku, invItem);
          }

          const errors: string[] = [];
          for (const [sku, newQty] of newQtyBySku) {
            if (newQty <= 0) continue;
            const invItem = invoiceItemBySku.get(sku);
            if (!invItem) {
              if (!oldQtyBySku.has(sku)) {
                errors.push(
                  `${sku}: not on parent invoice — cannot return what wasn't sold.`
                );
              }
              continue;
            }
            const invoicedQty = Number(invItem.quantity ?? 0);
            const totalRefunded = Number(invItem.refunded_quantity ?? 0);
            const thisCmOldQty = oldQtyBySku.get(sku) ?? 0;
            const refundedByOthers = Math.max(
              0,
              totalRefunded - thisCmOldQty
            );
            const allowed = invoicedQty - refundedByOthers;
            if (newQty > allowed) {
              errors.push(
                `${sku}: requested ${newQty}, max allowed ${allowed} ` +
                  `(invoiced ${invoicedQty}, already returned on other credit memos ${refundedByOthers}).`
              );
            }
          }
          if (errors.length > 0) {
            res.status(409).json({
              error: `Quantity validation failed:\n${errors.join("\n")}`,
            });
            return;
          }
        }
      } catch (qtyErr: any) {
        logger.warn(
          `[edit CM] Per-item quantity guard skipped: ${qtyErr.message}`
        );
      }
    }

    // ── Inventory delta adjustment ─────────────────────────────────────────────
    // old_restockable = qty - damaged_qty per variant (what was added on complete)
    // new_restockable = new_qty - new_damaged_qty per variant
    // delta = new_restockable - old_restockable → apply to stocked_quantity
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
      const oldByVariant = new Map<string, { qty: number; damaged: number }>();
      for (const item of creditMemo.items as any[]) {
        if (!item.variant_id) continue;
        const prev = oldByVariant.get(item.variant_id) ?? { qty: 0, damaged: 0 };
        oldByVariant.set(item.variant_id, {
          qty: prev.qty + Number(item.quantity ?? 0),
          damaged: prev.damaged + Number(item.damaged_qty ?? 0),
        });
      }

      const newByVariant = new Map<string, { qty: number; damaged: number }>();
      for (const item of newItems) {
        if (!item.variantId) continue;
        const prev = newByVariant.get(item.variantId) ?? { qty: 0, damaged: 0 };
        newByVariant.set(item.variantId, {
          qty: prev.qty + Number(item.quantity ?? 0),
          damaged: prev.damaged + Number(item.damagedQty ?? 0),
        });
      }

      const allVariantIds = new Set([
        ...oldByVariant.keys(),
        ...newByVariant.keys(),
      ]);

      for (const variantId of allVariantIds) {
        try {
          const old = oldByVariant.get(variantId) ?? { qty: 0, damaged: 0 };
          const nw = newByVariant.get(variantId) ?? { qty: 0, damaged: 0 };
          const oldRestockable = Math.max(0, old.qty - old.damaged);
          const newRestockable = Math.max(0, nw.qty - nw.damaged);
          const delta = newRestockable - oldRestockable;
          if (delta === 0) continue;

          const query = req.scope.resolve("query");
          const { data } = await query.graph({
            entity: "product_variant",
            fields: [
              "id",
              "inventory_items.*",
              "inventory_items.inventory.id",
            ],
            filters: { id: variantId },
          });
          const invItemId = data[0]?.inventory_items?.[0]?.inventory?.id;
          if (!invItemId) continue;

          const levels = await inventoryService.listInventoryLevels({
            inventory_item_id: invItemId,
            location_id: locationId,
          });
          const firstLevel = levels?.[0];
          if (!firstLevel) continue;

          const newQty = Math.max(
            0,
            (firstLevel.stocked_quantity ?? 0) + delta
          );
          await inventoryService.updateInventoryLevels({
            id: firstLevel.id,
            inventory_item_id: invItemId,
            location_id: locationId,
            stocked_quantity: newQty,
          } as any);
          touchedInventoryItemIds.add(invItemId);
          logger.info(
            `[edit CM] Inventory delta for ${variantId}: ${delta > 0 ? "+" : ""}${delta} → ${newQty}`
          );
        } catch (invErr: any) {
          logger.warn(
            `[edit CM] Inventory adjustment failed for ${variantId}: ${invErr.message}`
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

    // ── Update customer_payment amount ─────────────────────────────────────────
    if (cmNumber) {
      try {
        const payRow = await pgConnection("customer_payment")
          .where({ reference: cmNumber, type: "credit_memo" })
          .whereNot({ status: "voided" })
          .whereNull("deleted_at")
          .first();

        if (payRow) {
          await pgConnection("customer_payment").where({ id: payRow.id }).update({
            amount: dbTotals.total,
            raw_amount: JSON.stringify({
              value: String(dbTotals.total),
              precision: 20,
            }),
            updated_at: new Date(),
          });
          logger.info(
            `[edit CM] Updated customer_payment ${payRow.id} → ${dbTotals.total} cents`
          );
        }
      } catch (payErr: any) {
        logger.warn(
          `[edit CM] Could not update customer_payment: ${payErr.message}`
        );
      }
    }

    // ── Update parent invoice refunded amounts ────────────────────────────────
    if (creditMemo.order_id) {
      try {
        const invoiceService = req.scope.resolve("invoices") as any;
        const invoices = await invoiceService.listPosInvoices(
          { order_id: creditMemo.order_id },
          { relations: ["items"], order: { issued_at: "DESC" } }
        );
        const invoice = invoices?.[0];
        if (invoice) {
          const oldTotal = Number(creditMemo.total ?? 0);
          const oldShipping = Number(creditMemo.shipping ?? 0);
          const totalDiff = dbTotals.total - oldTotal;
          const shipDiff = dbTotals.shipping - oldShipping;

          const prevRefunded = Number(invoice.refunded_amount ?? 0);
          const newRefunded = Math.max(0, prevRefunded + totalDiff);
          const newRefShip = Math.max(
            0,
            Number(invoice.refunded_shipping ?? 0) + shipDiff
          );
          const amountPaid = Number(invoice.amount_paid ?? 0);
          const invoiceTotal = Number(invoice.total ?? 0);

          let newStatus: string;
          if (newRefunded > 0) {
            newStatus =
              newRefunded >= invoiceTotal - 1 ? "refunded" : "partially_refunded";
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

          // Update per-item refunded_quantity using sku-based delta
          const oldQtyBySku = new Map<string, number>();
          for (const item of creditMemo.items as any[]) {
            if (item.sku)
              oldQtyBySku.set(
                item.sku,
                (oldQtyBySku.get(item.sku) ?? 0) + Number(item.quantity ?? 0)
              );
          }
          const newQtyBySku = new Map<string, number>();
          for (const item of newItems) {
            if (item.sku)
              newQtyBySku.set(
                item.sku,
                (newQtyBySku.get(item.sku) ?? 0) + Number(item.quantity ?? 0)
              );
          }
          const allSkus = new Set([
            ...oldQtyBySku.keys(),
            ...newQtyBySku.keys(),
          ]);
          for (const sku of allSkus) {
            const delta =
              (newQtyBySku.get(sku) ?? 0) - (oldQtyBySku.get(sku) ?? 0);
            if (delta === 0) continue;
            try {
              await pgConnection("pos_invoice_item")
                .where({ invoice_id: invoice.id, sku })
                .update({
                  refunded_quantity: pgConnection.raw(
                    `GREATEST(0, COALESCE(refunded_quantity, 0) + ?)`,
                    [delta]
                  ),
                });
            } catch (skuErr: any) {
              logger.warn(
                `[edit CM] Could not update refunded_quantity for sku ${sku}: ${skuErr.message}`
              );
            }
          }

          logger.info(
            `[edit CM] Invoice ${invoice.id} → refunded_amount: ${newRefunded}, status: ${newStatus}`
          );
        }
      } catch (invErr: any) {
        logger.warn(
          `[edit CM] Could not update parent invoice: ${invErr.message}`
        );
      }
    }

    // ── Snapshot avg unit cost ────────────────────────────────────────────────
    const costVariantIds = newItems
      .map((i) => i.variantId)
      .filter((v): v is string => !!v);
    const costMap = await getVariantAvgCostBatch(req.scope, costVariantIds);

    // ── Update CM record + replace items ──────────────────────────────────────
    const updateMethodName: string =
      typeof (creditMemoService as any).updatePosCreditMemos === "function"
        ? "updatePosCreditMemos"
        : typeof (creditMemoService as any).updatePosCreditMemoes === "function"
          ? "updatePosCreditMemoes"
          : (Object.keys(creditMemoService as any).find(
                (k) =>
                  k.startsWith("update") && k.toLowerCase().includes("credit")
              ) ?? "updatePosCreditMemos");

    const oldQbTxnId = (creditMemo as any).qb_txn_id as string | null;
    const oldQbRefNumber = (creditMemo as any).qb_ref_number as
      | string
      | null;

    // Merge metadata: preserve background fields (original_shipping_cents,
    // original_discount_cents, etc.) from the existing record and let the
    // client override / extend them.
    const mergedMetadata: Record<string, unknown> = {
      ...((creditMemo as any).metadata ?? {}),
      ...(payload?.metadata ?? {}),
    };
    // The QB Subtotal/Discount TxnLineIDs are owned exclusively by the pipeline
    // poller, which writes them from the real CreditMemoRet. Omit the key here
    // rather than echo back the snapshot this request read at its start: a
    // confirm landing mid-request would otherwise be overwritten with a stale
    // pair, and a stale synthetic id makes the next Mod fail outright. Medusa's
    // update deep-MERGES jsonb, so an omitted key keeps whatever the DB holds.
    delete mergedMetadata[CM_SYNTHETIC_LINE_IDS_META_KEY];

    // Read the pair BEFORE the update, off the row this request loaded.
    const storedSyntheticLineIds = readQbSyntheticLineIds(
      (creditMemo as any).metadata
    );

    await (creditMemoService as any)[updateMethodName]({
      id,
      customer_id: payload?.customer_id ?? creditMemo.customer_id,
      notes: payload?.notes ?? creditMemo.notes,
      sales_rep: payload?.sales_rep !== undefined
        ? payload.sales_rep
        : creditMemo.sales_rep,
      shipping_option_id:
        shipping?.optionId ?? creditMemo.shipping_option_id ?? null,
      shipping_option_name:
        shipping?.optionName ?? creditMemo.shipping_option_name ?? null,
      metadata: mergedMetadata,
      // qb_txn_id / qb_edit_sequence stay intact — credit_memo_mod uses them.
      ...dbTotals,
    });

    // Load existing items BEFORE deletion to capture per-SKU qb_txn_line_id
    // mapping. Each SKU keeps a queue of TxnLineIDs so duplicate-SKU lines are
    // mapped in submission order.
    const existingItems = await creditMemoService.listPosCreditMemoItems({
      credit_memo_id: id,
    });
    // Sort before queueing. The rows come back from a hasMany read with no
    // ORDER BY, so Postgres is free to return them in any order — and the
    // per-SKU queue below assigns line IDENTITY, not just display order. With a
    // duplicate SKU (17 credit memos and 66 invoices have one today) an
    // unordered read hands line A's TxnLineID to line B, so QB ends up with the
    // quantities/prices swapped between two lines of the same item. The totals
    // still reconcile, which is exactly what makes it invisible.
    // ids are ULIDs → ascending id == insertion order == the order the previous
    // edit wrote them, so occurrence N maps to occurrence N.
    const orderedExistingItems = [...(existingItems as any[])].sort((a, b) =>
      String(a.id).localeCompare(String(b.id))
    );
    const txnLineIdQueueBySku = new Map<string, string[]>();
    for (const it of orderedExistingItems) {
      const sku = (it.sku ?? "") as string;
      const tlid = (it.qb_txn_line_id ?? null) as string | null;
      if (sku && tlid) {
        const arr = txnLineIdQueueBySku.get(sku) ?? [];
        arr.push(tlid);
        txnLineIdQueueBySku.set(sku, arr);
      }
    }
    if (existingItems.length > 0) {
      await creditMemoService.deletePosCreditMemoItems(
        existingItems.map((i: any) => i.id)
      );
    }
    // Plan new rows: pop a preserved TxnLineID from the per-SKU queue when
    // available so subsequent edits stay stable.
    const newItemPlans = newItems.map((item) => {
      const sku = (item.sku ?? "") as string;
      const queue = txnLineIdQueueBySku.get(sku);
      const reusedTxnLineId = queue && queue.length > 0 ? queue.shift()! : null;
      return { item, reusedTxnLineId };
    });
    await creditMemoService.createPosCreditMemoItems(
      newItemPlans.map(({ item, reusedTxnLineId }) => {
        const cost = item.variantId ? costMap.get(item.variantId) : undefined;
        const price = item.effectiveUnitPrice ?? item.unitPrice;
        return {
          credit_memo_id: id,
          variant_id: item.variantId ?? null,
          sku: item.sku ?? null,
          title: item.title,
          description: item.salesDescription ?? item.title,
          thumbnail: item.thumbnail ?? null,
          quantity: item.quantity,
          damaged_qty: item.damagedQty ?? 0,
          unit_price: Math.round(price * 100),
          line_total: Math.round(price * 100 * item.quantity),
          average_unit_cost: cost?.cost ?? null,
          average_unit_cost_synced_at: cost?.synced_at ?? null,
          qb_txn_line_id: reusedTxnLineId,
        };
      })
    );

    // ── QB: enqueue one fresh payload ────────────────────────────────────────
    // Synced CMs use CreditMemoMod. Completed-but-unsynced CMs may have a failed
    // CreditMemoAdd row; editing must replace that stale create payload.
    if (process.env.QB_ORDER_FLOW_ENABLED === "true") {
      try {
        // Build QB items from updated data
        const positiveItemPlans = newItemPlans.filter(
          ({ item }) => Number(item.quantity ?? 0) > 0
        );
        if (positiveItemPlans.length === 0) {
          throw new Error("No positive-quantity return lines to sync");
        }

        const variantIds = positiveItemPlans
          .map(({ item }) => item.variantId)
          .filter((v): v is string => !!v);

        const variants: any[] = variantIds.length
          ? await pgConnection
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
              variantMetadata: v.variant_metadata ?? {},
              productMetadata: v.product_metadata ?? {},
            },
          ])
        );

        const qbItems: any[] = positiveItemPlans.map(({ item, reusedTxnLineId }) => {
          const price = item.effectiveUnitPrice ?? item.unitPrice ?? 0;
          const info = item.variantId
            ? variantInfoMap.get(item.variantId)
            : null;
          const meta = info?.variantMetadata ?? {};
          const productMeta = info?.productMetadata ?? {};
          const qbListId = meta?.quickbooks_id as string | undefined;
          const qbItemType = meta?.qb_item_type ?? productMeta?.qb_item_type;
          const isService = !!(
            !item.variantId ||
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
            // TxnLineID: preserved from prior CM line when SKU matched, else
            // "-1" so QB treats it as a new line. Lines from the original CM
            // that we omit here will be deleted by QB.
            ...(oldQbTxnId ? { TxnLineID: reusedTxnLineId ?? "-1" } : {}),
            ...(qbListId ? { productId: qbListId } : {}),
            productName: item.sku ?? item.title,
            quantity: item.quantity,
            price,
            amount: Number((price * item.quantity).toFixed(2)),
            desc: item.salesDescription ?? item.title,
            ...(typeof qbItemType === "string" ? { qbItemType } : {}),
            ...(isService ? { noSite: true, taxable: false } : {}),
          };
        });

        if (dbTotals.discount > 0) {
          // Reuse the Subtotal/Discount TxnLineIDs QB already holds so the Mod
          // UPDATES that pair instead of deleting and recreating it. Suppressed
          // whenever a product line is being ADDED: a QB Subtotal totals the
          // lines above it, and new lines are appended after existing ones, so
          // a reused Subtotal would stop covering the line just added. In that
          // case the pair is recreated at the end, exactly as before.
          const hasNewProductLines = positiveItemPlans.some(
            ({ reusedTxnLineId }) => !reusedTxnLineId
          );
          applyQbSyntheticLineIds(
            buildQbOrderDiscountLines(dbTotals.discount / 100),
            storedSyntheticLineIds,
            { isMod: !!oldQbTxnId, hasNewProductLines }
          ).forEach((l: any) => qbItems.push(l));
        }
        if (dbTotals.shipping > 0) {
          const shippingItem = buildShippingQbItem([
            {
              amount: dbTotals.shipping / 100,
              name: shipping?.optionName ?? "Shipping",
            },
          ]);
          if (shippingItem) qbItems.push(shippingItem);
        }

        const isTaxExempt = dbTotals.tax === 0 && dbTotals.subtotal > 0;

        const effectiveCustomerId =
          payload?.customer_id ?? creditMemo.customer_id;
        if (effectiveCustomerId) {
          const check = await requireQbCustomer({
            customerId: effectiveCustomerId,
            step: oldQbTxnId ? "credit_memo_mod" : "credit_memo",
            selfReferenceId: id,
            selfReferenceType: "credit_memo",
            selfMedusaRefNumber: cmNumber ?? null,
          });

          if ("waiting" in check) {
            logger.info(
              `[edit CM] ⏸ Waiting on customer before submitting ${oldQbTxnId ? "credit_memo_mod" : "credit_memo"}`
            );
          } else {
            const qbConfig = await getQbConfig();
            const cmSalesTaxCode = isTaxExempt
              ? qbConfig.exemptSalesTaxCode
              : qbConfig.defaultSalesTaxCode;
            const qbTaxItemListid = resolveTaxListid(
              isTaxExempt ? "exempt" : "florida",
              qbConfig
            );
            const salesRepRef = parseSalesRepInitials(
              payload?.sales_rep ?? creditMemo.sales_rep
            );

            await writePipelineRow({
              referenceId: id,
              referenceType: "credit_memo",
              step: oldQbTxnId ? "credit_memo_mod" : "credit_memo",
              status: "pending",
              qbTxnId: oldQbTxnId ?? undefined,
              qbRefNumber: oldQbRefNumber ?? cmNumber ?? null,
              medusaRefNumber: cmNumber ?? null,
              payload: {
                customerId: check.qbListId,
                date: getBusinessDateString(
                  (creditMemo as any).created_at ?? null
                ),
                memo: `POS Return ${cmNumber ?? ""}`.trim(),
                items: qbItems,
                salesTaxCode: cmSalesTaxCode,
                ...(qbTaxItemListid ? { qbTaxItemListid } : {}),
                ...(isTaxExempt ? { taxExempt: true } : {}),
                ...(salesRepRef ? { salesRepRef } : {}),
              },
            });
            logger.info(
              `[edit CM] Enqueued ${oldQbTxnId ? "credit_memo_mod" : "credit_memo"} for ${id}`
            );
          }
        }
      } catch (qbErr: any) {
        logger.warn(
          `[edit CM] credit_memo_mod enqueue failed (non-fatal): ${qbErr.message}`
        );
      }
    }

    res.status(200).json({ success: true, credit_memo_id: id });
  } catch (e: any) {
    logger.error(`[credit_memos edit] failed: ${e.message}`);
    res.status(500).json({ success: false, message: e.message });
  }
}
