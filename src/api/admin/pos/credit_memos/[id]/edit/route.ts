import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Modules } from "@medusajs/utils";

import { parseSalesRepInitials } from "../../../../../../lib/quickbooks/parse-sales-rep";
import { getQbConfig } from "../../../../../../lib/quickbooks/qb-config";
import {
  buildQbOrderDiscountLines,
  buildShippingQbItem,
} from "../../../../../../lib/quickbooks/order-flow-core";
import {
  writePipelineRow,
  requireQbCustomer,
  invalidateEditSequence,
} from "../../../../../../lib/quickbooks/qb-pipeline";
import { getVariantAvgCostBatch } from "../../../../../../lib/cost/get-variant-avg-cost";
import { CREDIT_MEMO_MODULE } from "../../../../../../modules/credit_memos";
import CreditMemoModuleService from "../../../../../../modules/credit_memos/service";

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

    // ── Inventory delta adjustment ─────────────────────────────────────────────
    // old_restockable = qty - damaged_qty per variant (what was added on complete)
    // new_restockable = new_qty - new_damaged_qty per variant
    // delta = new_restockable - old_restockable → apply to stocked_quantity
    const allLocations = await stockLocationService.listStockLocations({});
    const locationId = allLocations[0]?.id;

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
    const oldQbEditSeq = (creditMemo as any).qb_edit_sequence as
      | string
      | null;
    const oldQbRefNumber = (creditMemo as any).qb_ref_number as
      | string
      | null;

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
      qb_txn_id: null,
      qb_edit_sequence: null,
      ...dbTotals,
    });

    const existingItems = await creditMemoService.listPosCreditMemoItems({
      credit_memo_id: id,
    });
    if (existingItems.length > 0) {
      await creditMemoService.deletePosCreditMemoItems(
        existingItems.map((i: any) => i.id)
      );
    }
    await creditMemoService.createPosCreditMemoItems(
      newItems.map((item) => {
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
        };
      })
    );

    // ── QB: void old CM + enqueue fresh one ───────────────────────────────────
    if (oldQbTxnId && process.env.QB_ORDER_FLOW_ENABLED === "true") {
      try {
        await writePipelineRow({
          referenceId: id,
          referenceType: "credit_memo",
          step: "void_credit_memo",
          status: "pending",
          qbTxnId: oldQbTxnId,
          qbRefNumber: oldQbRefNumber ?? cmNumber ?? null,
          medusaRefNumber: cmNumber ?? null,
          payload: { editSequence: oldQbEditSeq },
        });
        logger.info(
          `[edit CM] Enqueued void_credit_memo for old txnId ${oldQbTxnId}`
        );

        await invalidateEditSequence("credit_memo", oldQbTxnId).catch(() => {});

        // Build QB items from updated data
        const variantIds = newItems
          .map((i) => i.variantId)
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

        const qbItems: any[] = newItems.map((item) => {
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
          buildQbOrderDiscountLines(dbTotals.discount / 100).forEach(
            (l: any) => qbItems.push(l)
          );
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

        let isTaxExempt = false;
        try {
          const effectiveInvoiceId =
            payload?.invoice_id ?? creditMemo.invoice_id;
          const effectiveCustomerId =
            payload?.customer_id ?? creditMemo.customer_id;
          if (effectiveInvoiceId) {
            const invRes = await pgConnection.raw(
              `SELECT tax, subtotal FROM pos_invoice WHERE id = ? LIMIT 1`,
              [effectiveInvoiceId]
            );
            const inv = invRes?.rows?.[0];
            if (inv)
              isTaxExempt =
                Number(inv.tax) === 0 && Number(inv.subtotal) > 0;
          } else if (effectiveCustomerId) {
            const custRes = await pgConnection.raw(
              `SELECT metadata FROM customer WHERE id = ? LIMIT 1`,
              [effectiveCustomerId]
            );
            const flag = custRes?.rows?.[0]?.metadata?.is_tax_exempt;
            isTaxExempt =
              flag === true ||
              (typeof flag === "string" &&
                (flag.toLowerCase() === "yes" ||
                  flag.toLowerCase() === "true"));
          }
        } catch {}

        const effectiveCustomerId =
          payload?.customer_id ?? creditMemo.customer_id;
        if (effectiveCustomerId) {
          const check = await requireQbCustomer({
            customerId: effectiveCustomerId,
            step: "credit_memo",
            selfReferenceId: id,
            selfReferenceType: "credit_memo",
            selfMedusaRefNumber: cmNumber ?? null,
          });

          if ("waiting" in check) {
            logger.info(
              `[edit CM] ⏸ Waiting on customer before re-creating QB CM`
            );
          } else {
            const qbConfig = await getQbConfig();
            const cmSalesTaxCode = isTaxExempt
              ? qbConfig.exemptSalesTaxCode
              : qbConfig.defaultSalesTaxCode;
            const salesRepRef = parseSalesRepInitials(
              payload?.sales_rep ?? creditMemo.sales_rep
            );

            await writePipelineRow({
              referenceId: id,
              referenceType: "credit_memo",
              step: "credit_memo",
              status: "pending",
              medusaRefNumber: cmNumber ?? null,
              qbRefNumber: cmNumber ?? null,
              payload: {
                customerId: check.qbListId,
                date: new Date().toISOString().split("T")[0],
                memo: `POS Return ${cmNumber ?? ""}`.trim(),
                items: qbItems,
                salesTaxCode: cmSalesTaxCode,
                ...(salesRepRef ? { salesRepRef } : {}),
              },
            });
            logger.info(`[edit CM] Enqueued new credit_memo for ${id}`);
          }
        }
      } catch (qbErr: any) {
        logger.warn(
          `[edit CM] QB re-enqueue failed (non-fatal): ${qbErr.message}`
        );
      }
    }

    res.status(200).json({ success: true, credit_memo_id: id });
  } catch (e: any) {
    logger.error(`[credit_memos edit] failed: ${e.message}`);
    res.status(500).json({ success: false, message: e.message });
  }
}
