import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { CREDIT_MEMO_MODULE } from "../../../../../modules/credit_memos";
import CreditMemoModuleService from "../../../../../modules/credit_memos/service";

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const logger = req.scope.resolve("logger");
  const creditMemoService: CreditMemoModuleService =
    req.scope.resolve(CREDIT_MEMO_MODULE);

  try {
    const { id, payload, items, totals, action, shipping } = req.body as any;

    let resolvedId = id;

    // Cents conversion for DB storage
    const dbTotals = {
      subtotal: Math.round((totals?.subtotal || 0) * 100),
      discount: Math.round((totals?.totalDiscount || 0) * 100), // POS gives totalDiscount (line + order)
      tax: Math.round((totals?.tax || 0) * 100),
      shipping: Math.round((totals?.shipping || 0) * 100),
      total: Math.round((totals?.total || 0) * 100),
    };

    // ── Invoice-linked validation ─────────────────────────────────────────────────
    if (payload.invoice_id && items && items.length > 0) {
      try {
        const pgConnection = req.scope.resolve("__pg_connection__") as any;
        const invItems = await pgConnection("pos_invoice_item")
          .where({ invoice_id: payload.invoice_id })
          .select("variant_id", "sku", "quantity");

        if (invItems.length > 0) {
          for (const item of items) {
            const match = invItems.find(
              (ii: any) =>
                (item.variantId && ii.variant_id === item.variantId) ||
                (item.sku && ii.sku === item.sku)
            );
            if (!match) {
              res.status(400).json({
                success: false,
                message: `Item "${item.title}" (${item.sku}) was not found on invoice ${payload.invoice_id}`,
              });
              return;
            }
            if (item.quantity > match.quantity) {
              res.status(400).json({
                success: false,
                message: `Return quantity ${item.quantity} exceeds invoiced quantity ${match.quantity} for "${item.title}"`,
              });
              return;
            }
          }
        }
      } catch (valErr: any) {
        logger.warn(
          `[credit_memos sync] Invoice validation skipped: ${valErr.message}`
        );
        // Non-blocking — continue if validation query fails
      }
    }

    // Resolve thumbnails from Medusa variants for items that don't have one
    const variantIds = (items ?? [])
      .filter((i: any) => i.variantId && !i.thumbnail)
      .map((i: any) => i.variantId as string);

    const thumbnailMap: Record<string, string> = {};
    if (variantIds.length > 0) {
      try {
        const query = req.scope.resolve("query");
        const { data: variants } = await query.graph({
          entity: "product_variant",
          fields: ["id", "product.thumbnail"],
          filters: { id: variantIds },
        });
        for (const v of variants) {
          if (v.id && (v as any).product?.thumbnail) {
            thumbnailMap[v.id] = (v as any).product.thumbnail;
          }
        }
      } catch (thumbErr: any) {
        logger.warn(
          `[credit_memos sync] Could not resolve thumbnails: ${thumbErr.message}`
        );
      }
    }

    const buildItems = (targetId: string) =>
      (items ?? []).map((item: any) => ({
        credit_memo_id: targetId,
        variant_id: item.variantId || null,
        sku: item.sku || null,
        title: item.title,
        description: item.salesDescription || item.title,
        thumbnail:
          item.thumbnail ||
          (item.variantId ? thumbnailMap[item.variantId] : null) ||
          null,
        quantity: item.quantity,
        damaged_qty: item.damagedQty ?? 0,
        unit_price: Math.round(
          (item.effectiveUnitPrice || item.unitPrice) * 100
        ),
        line_total: Math.round(
          (item.effectiveUnitPrice || item.unitPrice) * 100 * item.quantity
        ),
      }));

    if (action === "create" || id === "new" || !id || id.startsWith("new:")) {
      const pgConnection = req.scope.resolve("__pg_connection__") as any;
      const seqRes = await pgConnection.raw(
        `SELECT nextval('custom_credit_memo_seq') AS seq`
      );
      const nextCmNum = seqRes.rows[0].seq || seqRes.rows[0].SEQ;
      const cmNumber = `CM-${nextCmNum}`;

      // @ts-ignore - Medusa DML types it as Memoes but runtime is Memos
      const created = await (creditMemoService as any).createPosCreditMemos({
        credit_memo_number: cmNumber,
        order_id: payload.order_id || null,
        invoice_id: payload.invoice_id || null,
        customer_id: payload.customer_id || null,
        status: "created",
        notes: payload.notes || null,
        sales_rep: payload.sales_rep ?? null,
        shipping_option_id: shipping?.optionId || null,
        shipping_option_name: shipping?.optionName || null,
        ...dbTotals,
      });

      resolvedId = created.id;

      // 2. Add Items
      if (items && items.length > 0) {
        await creditMemoService.createPosCreditMemoItems(
          buildItems(resolvedId)
        );
      }

      // No need to update CM number suffix as we used proper pg sequence from the start
    } else {
      // UPDATE EXISTING

      // @ts-ignore
      await (creditMemoService as any).updatePosCreditMemos({
        id: resolvedId,
        customer_id: payload.customer_id || null,
        notes: payload.notes || null,
        sales_rep: payload.sales_rep ?? null,
        shipping_option_id: shipping?.optionId || null,
        shipping_option_name: shipping?.optionName || null,
        ...dbTotals,
      });

      // Re-create items (safest total sync approach, since they have no side effects)
      // First, delete current items
      const existingItems = await creditMemoService.listPosCreditMemoItems({
        credit_memo_id: resolvedId,
      });
      if (existingItems.length > 0) {
        await creditMemoService.deletePosCreditMemoItems(
          existingItems.map((i: any) => i.id)
        );
      }

      // Insert new ones
      if (items && items.length > 0) {
        await creditMemoService.createPosCreditMemoItems(
          buildItems(resolvedId)
        );
      }
    }

    res.status(200).json({ success: true, credit_memo_id: resolvedId });
  } catch (e: any) {
    logger.error(`[credit_memos sync] failed: ${e.message}`);
    res.status(500).json({ success: false, message: e.message });
  }
}
