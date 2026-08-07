import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/utils";

// 1.5.4: handleDraftOrderUpdated import removed — sync-pos now enqueues
// 'pending' rows; consolidator processes via the same handler.
import { getEstimateTxnId } from "../../../../lib/quickbooks/qb-metadata-types";
import { writePipelineRow } from "../../../../lib/quickbooks/qb-pipeline";
import { getDbPool } from "../../../utils/db-pool";

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY);
  const logger = req.scope.resolve("logger");
  const base = `http://localhost:${process.env.PORT ?? 9000}`;
  const authHeaders: Record<string, string> = {
    Cookie: String(req.headers["cookie"] ?? ""),
    Authorization: String(req.headers["authorization"] ?? ""),
    "Content-Type": "application/json",
  };

  const {
    id,
    action,
    payload,
    items,
    shipping_option_id,
    shipping_price,
    promotion_code,
    promotion_id,
    discount_type,
    discount_value,
    order_discount,
    customer_id,
  } = req.body as any;

  let resolvedId = id;
  let cartId = null;
  let displayId = null;

  const localFetch = async (path: string, options: RequestInit) => {
    try {
      const r = await fetch(`${base}${path}`, {
        ...options,
        headers: authHeaders,
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        throw new Error(
          `[sync-pos] ${options.method} ${path} failed (${r.status}): ${txt}`
        );
      }
      return await r.json().catch(() => ({}));
    } catch (err: any) {
      logger.error(err.message);
      throw err;
    }
  };

  try {
    if (action === "create") {
      // 0. Auto-resolve region
      let regionId: string | undefined;
      const regRes = await localFetch("/admin/regions?limit=1", {
        method: "GET",
      }).catch(() => null);
      if (regRes?.regions?.length > 0) {
        regionId = regRes.regions[0].id;
        payload.region_id = regionId;
      }

      // 1. Create wrapper
      // IMPORTANT: Medusa native draft-orders endpoint ignores custom_description, sort_order, etc.
      // If we send payload.items, they are natively created with standard titles.
      // Then our loop below creates them AGAIN. Result: duplicated items!
      // Solution: Strip them from payload here, because the loop will create them perfectly.
      delete payload.items;
      const createRes = await localFetch("/admin/draft-orders", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      resolvedId = createRes.draft_order.id;
      cartId = createRes.draft_order.cart_id;
      displayId = createRes.draft_order.display_id;

      // 2. Add Items
      for (const item of items) {
        await localFetch(`/admin/draft-orders/${resolvedId}/add-item-force`, {
          method: "POST",
          body: JSON.stringify({
            variant_id: item.variantId,
            quantity: item.quantity,
            unit_price: item.effectiveUnitPrice,
            line_discount: item.lineDiscount,
            original_unit_price: item.lineDiscount ? item.unitPrice : null,
            custom_title: item.title,
            custom_description: item.salesDescription,
            sort_order: item.sortOrder,
            attached_image: item.attachedImage ?? null,
          }),
        });
      }

      // 3. Shipping
      if (shipping_option_id) {
        await localFetch(
          `/admin/draft-orders/${resolvedId}/add-shipping-force`,
          {
            method: "POST",
            body: JSON.stringify({
              shipping_option_id,
              custom_amount: shipping_price ?? 0,
            }),
          }
        ).catch((e) =>
          logger.warn(`Shipping force failed on create: ${e.message}`)
        );
      }

      // 4. Promotions / Discounts
      if (promotion_code && promotion_id) {
        // Preset promo — apply existing by code+id
        await localFetch("/admin/pos-discount/apply-existing", {
          method: "POST",
          body: JSON.stringify({
            order_id: resolvedId,
            promotion_code,
            promotion_id,
          }),
        }).catch((e) =>
          logger.warn(`Promotion failed on create: ${e.message}`)
        );
      } else if (promotion_code && discount_type && discount_value > 0) {
        // Custom promo — find-or-create canonical CPOS-PCT/FIXED via pos-discount
        const posDiscountRes = await localFetch("/admin/pos-discount", {
          method: "POST",
          body: JSON.stringify({
            order_id: resolvedId,
            discount_type,
            discount_value,
          }),
        }).catch((e) => {
          logger.warn(`Discount failed on create: ${e.message}`);
          return null;
        });

        // Write canonical code back to metadata so cleanup/compute-tax stay consistent
        const canonicalCode = posDiscountRes?.promotion_code;
        if (canonicalCode && canonicalCode !== promotion_code) {
          await localFetch(`/admin/draft-orders/${resolvedId}`, {
            method: "POST",
            body: JSON.stringify({
              metadata: { promotion_code: canonicalCode },
            }),
          }).catch((e) =>
            logger.warn(`Failed to persist canonical promo code: ${e.message}`)
          );
        }
      }

      // Write "waiting" pipeline row immediately so it appears in the QB Pipeline UI
      // (Medusa v2 does not emit draft_order.created — we must write this directly)
      if (process.env.QB_ORDER_FLOW_ENABLED === "true" && resolvedId) {
        const friendlyRef = displayId ? `E${displayId}` : null;
        writePipelineRow({
          orderId: resolvedId,
          step: "estimate",
          status: "waiting",
          medusaRefNumber: friendlyRef,
        }).catch((e) =>
          logger.warn(
            `[sync-pos] Could not write waiting pipeline row: ${e.message}`
          )
        );
      }
    } else if (action === "update") {
      // 0. Handle Pos Transfer
      // Fetch the old order natively to ensure metadata isn't stripped by API projections
      let draftOrderModel: any = null;
      try {
        const { data } = await query.graph({
          entity: "order",
          fields: [
            "id",
            "customer_id",
            "metadata",
            "display_id",
            "items.*",
            "cart.*",
          ],
          filters: { id: resolvedId },
        });
        draftOrderModel = data?.[0];
      } catch (e: any) {
        logger.warn(`Failed to fetch draft order natively: ${e.message}`);
      }

      if (
        customer_id &&
        draftOrderModel?.customer_id &&
        customer_id !== draftOrderModel.customer_id
      ) {
        try {
          await localFetch(`/admin/pos-transfer`, {
            method: "POST",
            body: JSON.stringify({
              id: resolvedId,
              customer_id,
            }),
          });
        } catch (e: any) {
          const msg = String(e?.message ?? "");
          // The transfer chokepoint REJECTED the change (order already
          // invoiced or has linked payments — e.g. a stale estimate tab of a
          // converted order). Abort the whole save and surface the rejection;
          // swallowing it here is how a customer change used to half-apply.
          if (
            msg.includes("INVOICES_EXIST") ||
            msg.includes("PAYMENTS_LINKED") ||
            msg.includes("PAYMENT_APPLIED") ||
            msg.includes("PAYMENTS_WEB_LOCKED")
          ) {
            const jsonStart = msg.indexOf("{");
            let body: Record<string, unknown> = {
              error: "Customer change rejected",
              code: "TRANSFER_REJECTED",
            };
            if (jsonStart >= 0) {
              try {
                body = JSON.parse(msg.slice(jsonStart));
              } catch {
                /* keep generic body */
              }
            }
            res.status(409).json(body);
            return;
          }
          logger.warn(`Transfer failed: ${msg}`);
        }
      }

      // 1. Update Wrapper metadata
      const updateRes = await localFetch(`/admin/draft-orders/${resolvedId}`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      cartId = updateRes.draft_order?.cart_id;

      const oldItems =
        draftOrderModel?.items ?? draftOrderModel?.cart?.items ?? [];
      const newItems = items;

      // 2. Delete missing items
      for (const old of oldItems) {
        if (!newItems.find((n: any) => n.localId === old.id)) {
          await localFetch(
            `/admin/draft-orders/${resolvedId}/delete-item-force`,
            {
              method: "POST",
              body: JSON.stringify({ line_item_id: old.id }),
            }
          );
        }
      }

      // 3. Add or Update items
      let itemsChanged = false;
      for (const item of newItems) {
        const existing = oldItems.find((o: any) => o.id === item.localId);
        const hasAttachedImage = Object.prototype.hasOwnProperty.call(
          item,
          "attachedImage"
        );
        if (existing) {
          const changed =
            item.effectiveUnitPrice !== (existing.unit_price ?? 0) ||
            item.quantity !== (existing.quantity ?? 1) ||
            (item.sortOrder !== undefined &&
              item.sortOrder !== existing.metadata?.sort_order) ||
            JSON.stringify(item.lineDiscount ?? null) !==
              JSON.stringify(existing.metadata?.line_discount ?? null) ||
            item.unitPrice !== existing.metadata?.original_unit_price ||
            item.priceListId !== (existing.metadata?.price_list_id ?? null) ||
            item.priceListLabel !==
              (existing.metadata?.price_list_label ?? "Default") ||
            item.title !== existing.title ||
            item.salesDescription !== existing.metadata?.sales_description ||
            (hasAttachedImage &&
              (item.attachedImage ?? null) !==
                (existing.metadata?.attached_image ?? null));

          if (changed) {
            await localFetch(
              `/admin/draft-orders/${resolvedId}/update-item-force`,
              {
                method: "POST",
                body: JSON.stringify({
                  line_item_id: existing.id,
                  quantity: item.quantity,
                  unit_price: item.effectiveUnitPrice,
                  ...(item.sortOrder !== undefined
                    ? { sort_order: item.sortOrder }
                    : {}),
                  line_discount: item.lineDiscount,
                  original_unit_price: item.unitPrice,
                  price_list_id: item.priceListId,
                  price_list_label: item.priceListLabel,
                  custom_title: item.title,
                  custom_description: item.salesDescription,
                  ...(hasAttachedImage
                    ? { attached_image: item.attachedImage ?? null }
                    : {}),
                }),
              }
            );
            itemsChanged = true;
          }
        } else {
          await localFetch(`/admin/draft-orders/${resolvedId}/add-item-force`, {
            method: "POST",
            body: JSON.stringify({
              variant_id: item.variantId,
              quantity: item.quantity,
              unit_price: item.effectiveUnitPrice,
              ...(item.sortOrder !== undefined
                ? { sort_order: item.sortOrder }
                : {}),
              line_discount: item.lineDiscount,
              original_unit_price: item.unitPrice,
              price_list_id: item.priceListId,
              price_list_label: item.priceListLabel,
              custom_title: item.title,
              custom_description: item.salesDescription,
              attached_image: item.attachedImage ?? null,
            }),
          });
          itemsChanged = true;
        }
      }

      // 4. Shipping sync
      const oldMethods =
        draftOrderModel?.shipping_methods ??
        draftOrderModel?.cart?.shipping_methods ??
        [];
      const oldShippingId = oldMethods[0]?.shipping_option_id ?? null;

      if (shipping_option_id !== oldShippingId || itemsChanged) {
        if (shipping_option_id) {
          await localFetch(
            `/admin/draft-orders/${resolvedId}/add-shipping-force`,
            {
              method: "POST",
              body: JSON.stringify({
                shipping_option_id,
                custom_amount: shipping_price ?? 0,
              }),
            }
          ).catch((e) => logger.warn(`Update shipping failed: ${e.message}`));
        } else if (oldShippingId) {
          await localFetch(
            `/admin/draft-orders/${resolvedId}/remove-shipping`,
            { method: "DELETE" }
          ).catch((e) => logger.warn(`Remove shipping failed: ${e.message}`));
        }
      }

      // 5. Promo sync
      const savedPromoCode = draftOrderModel?.metadata?.promotion_code ?? null;
      const currentPromoCode = promotion_code ?? null;
      const promoNeedsSync =
        !!currentPromoCode || currentPromoCode !== savedPromoCode;

      if (promoNeedsSync) {
        if (currentPromoCode && promotion_id) {
          // Preset promo — apply existing by code+id
          await localFetch("/admin/pos-discount/apply-existing", {
            method: "POST",
            body: JSON.stringify({
              order_id: resolvedId,
              promotion_code: currentPromoCode,
              promotion_id,
              expected_discount: order_discount,
            }),
          }).catch((e) => logger.warn(`Sync promotion failed: ${e.message}`));
        } else if (currentPromoCode && discount_type && discount_value > 0) {
          // Custom promo — find-or-create canonical CPOS-PCT/FIXED via pos-discount
          const posDiscountRes = await localFetch("/admin/pos-discount", {
            method: "POST",
            body: JSON.stringify({
              order_id: resolvedId,
              discount_type,
              discount_value,
              // Se manda SIEMPRE el código vivo, sin compararlo con
              // `currentPromoCode`.
              //
              // Esa comparación era contra lo que mandó el cliente, no contra el
              // código que esta ruta va a aplicar: el POS puede mandar
              // `ORDER-DISCOUNT-10%` mientras `discount_type/value` resuelven a
              // `CPOS-PCT-1000`, así que los dos "coincidían" y el descuento
              // anterior quedaba vivo. Medido en sandbox: el nuevo 10% salía
              // 43.20 (10% de 432.00) en vez de 48.00, porque se calculó sobre el
              // neto que todavía tenía restado el anterior.
              //
              // Mandarlo de más es inofensivo: `/admin/pos-discount` descarta el
              // código que está por aplicar antes de remover nada.
              existing_promo_code:
                savedPromoCode ?? currentPromoCode ?? undefined,
            }),
          }).catch((e) => {
            logger.warn(`Custom discount failed on update: ${e.message}`);
            return null;
          });

          // Write canonical code back to metadata so cleanup/compute-tax stay consistent
          const canonicalCode = posDiscountRes?.promotion_code;
          if (canonicalCode && canonicalCode !== currentPromoCode) {
            await localFetch(`/admin/draft-orders/${resolvedId}`, {
              method: "POST",
              body: JSON.stringify({
                metadata: { promotion_code: canonicalCode },
              }),
            }).catch((e) =>
              logger.warn(
                `Failed to persist canonical promo code: ${e.message}`
              )
            );
          }
        } else if (savedPromoCode) {
          await localFetch("/admin/pos-discount", {
            method: "DELETE",
            body: JSON.stringify({
              order_id: resolvedId,
              promotion_code: savedPromoCode,
            }),
          }).catch((e) => logger.warn(`Remove promotion failed: ${e.message}`));
        }
      }

      // 5b. QuickBooks Pipeline hooks for Draft Orders (Estimates)
      logger.info(
        `[sync-pos] QB Flow Enabled: ${process.env.QB_ORDER_FLOW_ENABLED}, DraftOrder ID: ${resolvedId}`
      );
      if (process.env.QB_ORDER_FLOW_ENABLED === "true") {
        const qbTxnId = getEstimateTxnId(draftOrderModel?.metadata);
        logger.info(`[sync-pos] qbTxnId found: ${qbTxnId}`);
        if (qbTxnId) {
          try {
            await localFetch(`/admin/draft-orders/${resolvedId}`, {
              method: "POST",
              body: JSON.stringify({ metadata: { qb_sync_status: "pending" } }),
            }).catch(() => {});

            // Delegate to the shared MOD handler. It handles:
            //   - coalesceIfInFlight (rapid sequential saves → next_payload)
            //   - writePipelineRow(pending) (pre-flight + in-lock idempotent reset)
            //   - withQbSerialized (per-order single-writer guarantee)
            // 1.5.4: enqueue 'pending' for consolidator pick-up.
            await writePipelineRow({
              orderId: resolvedId,
              step: "estimate",
              status: "pending",
              // intent:"mod" — estimate already exists (qbTxnId). Without it the
              // QB_CREATE_STEPS guard no-ops a confirmed estimate row and the edit
              // never reaches QB (same bug as the SO post-edit-sync path).
              intent: "mod",
              qbTxnId,
            });
            logger.info(
              `[sync-pos] 📥 Enqueued estimate MOD for ${resolvedId} (modified)`
            );
          } catch (qbErr: any) {
            logger.error(
              `[sync-pos] Failed to queue QB sync for modified estimate: ${qbErr.message}`
            );
          }
        }
      }
    }

    // 6. Cleanup stale versioned data — mirrors post-edit-sync for orders.
    // Estimates don't use version history, so we purge old rows on every save
    // to prevent unbounded growth of order_item, order_summary, adjustments, etc.
    try {
      const pool = getDbPool();

      // a. Hard-delete soft-deleted adjustments
      const adjDel = await pool.query(
        `DELETE FROM order_line_item_adjustment
                 WHERE deleted_at IS NOT NULL
                   AND item_id IN (SELECT DISTINCT item_id FROM order_item WHERE order_id = $1)`,
        [resolvedId]
      );

      // b. Deduplicate ACTIVE adjustments — keep only the most-recent row per (item, promo code).
      //    This fixes accumulation caused by confirmDraftOrderEditWorkflow adding new rows
      //    without removing the previous ones.
      const adjDupDel = await pool.query(
        `DELETE FROM order_line_item_adjustment
                 WHERE deleted_at IS NULL
                   AND item_id IN (SELECT DISTINCT item_id FROM order_item WHERE order_id = $1)
                   AND id NOT IN (
                       SELECT DISTINCT ON (item_id, code) id
                       FROM order_line_item_adjustment
                       WHERE deleted_at IS NULL
                         AND item_id IN (SELECT DISTINCT item_id FROM order_item WHERE order_id = $2)
                       ORDER BY item_id, code, created_at DESC
                   )`,
        [resolvedId, resolvedId]
      );

      // c. Remove adjustments for promo codes that are no longer the active promotion.
      //    When a user switches from promo A → promo B, apply-existing adds promo B's
      //    adjustments but never removes promo A's — this cleans them up.
      //    Safety: re-read the order's metadata.promotion_code here because the CREATE
      //    and UPDATE branches above overwrite it with the canonical CPOS-* code after
      //    applying a custom discount. Using the stale body value would mis-match the
      //    real adjustment codes and wipe valid discounts.
      let adjOldPromoDel: { rowCount: number | null } = { rowCount: 0 };
      let activePromoCode: string | null = promotion_code ?? null;
      try {
        const { data: freshRows } = await query.graph({
          entity: "order",
          fields: ["metadata"],
          filters: { id: resolvedId },
        });
        const freshMeta = (freshRows?.[0] as any)?.metadata ?? {};
        if (freshMeta.promotion_code)
          activePromoCode = freshMeta.promotion_code;
      } catch {
        /* fall back to body value */
      }

      if (activePromoCode) {
        adjOldPromoDel = await pool.query(
          `DELETE FROM order_line_item_adjustment
                     WHERE deleted_at IS NULL
                       AND code != $1
                       AND item_id IN (SELECT DISTINCT item_id FROM order_item WHERE order_id = $2)`,
          [activePromoCode, resolvedId]
        );
      }

      // d. Delete old order_item versions — keep only the latest version per item
      const oiDel = await pool.query(
        `DELETE FROM order_item
                 WHERE order_id = $1
                   AND (item_id, version) NOT IN (
                       SELECT item_id, MAX(version) FROM order_item WHERE order_id = $2 GROUP BY item_id
                   )`,
        [resolvedId, resolvedId]
      );

      // d2. Delete adjustments stuck at old order_item versions. Without this,
      //     Medusa's join `adjustment.version = order_item.version` returns
      //     nothing and `discount_total` reports as 0 on the live order even
      //     though adjustments physically exist (orphaned-version bug).
      const adjVerDel = await pool.query(
        `DELETE FROM order_line_item_adjustment
                 WHERE item_id IN (SELECT DISTINCT item_id FROM order_item WHERE order_id = $1)
                   AND version != (SELECT MAX(version) FROM order_item WHERE order_id = $2)`,
        [resolvedId, resolvedId]
      );

      // e. Delete old order_change_action rows (keep only the latest order_change)
      const ocaDel = await pool.query(
        `DELETE FROM order_change_action
                 WHERE order_change_id IN (
                     SELECT id FROM order_change WHERE order_id = $1
                     AND id != (SELECT id FROM order_change WHERE order_id = $2 ORDER BY created_at DESC LIMIT 1)
                 )`,
        [resolvedId, resolvedId]
      );

      // f. Delete old order_change rows (keep only latest)
      const ocDel = await pool.query(
        `DELETE FROM order_change WHERE order_id = $1
                 AND id != (SELECT id FROM order_change WHERE order_id = $2 ORDER BY created_at DESC LIMIT 1)`,
        [resolvedId, resolvedId]
      );

      // g. Delete old order_summary versions (keep only latest)
      const osDel = await pool.query(
        `DELETE FROM order_summary WHERE order_id = $1
                 AND version != (SELECT MAX(version) FROM order_summary WHERE order_id = $2)`,
        [resolvedId, resolvedId]
      );

      logger.info(
        `[sync-pos] 🧹 Cleanup: adj_stale=${adjDel.rowCount ?? 0}, adj_dup=${adjDupDel.rowCount ?? 0}, adj_old_promo=${adjOldPromoDel.rowCount ?? 0}, adj_old_version=${adjVerDel.rowCount ?? 0}, order_item_old=${oiDel.rowCount ?? 0}, order_change_action=${ocaDel.rowCount ?? 0}, order_change=${ocDel.rowCount ?? 0}, order_summary=${osDel.rowCount ?? 0}`
      );
    } catch (cleanupErr: any) {
      logger.warn(`[sync-pos] 🧹 Cleanup non-fatal: ${cleanupErr.message}`);
    }

    // 7. Compute Tax Always (Fire & Forget / Sequential is fine locally)
    await localFetch(`/admin/draft-orders/${resolvedId}/compute-tax`, {
      method: "GET",
    }).catch(() => {});

    res.status(200).json({
      success: true,
      draft_order_id: resolvedId,
      cart_id: cartId,
      display_id: displayId,
    });
  } catch (e: any) {
    logger.error(`[sync-pos] Master sync failed: ${e.message}`);
    res.status(500).json({ success: false, message: e.message });
  }
}
