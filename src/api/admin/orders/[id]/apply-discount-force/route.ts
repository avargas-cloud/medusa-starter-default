import {
  createPromotionsWorkflow,
  addDraftOrderPromotionWorkflow,
  beginDraftOrderEditWorkflow,
  confirmDraftOrderEditWorkflow,
  cancelDraftOrderEditWorkflow,
} from "@medusajs/core-flows";
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { assertOrderEditable } from "../_lib/assert-order-editable";
import { assertWebOrderAuthorized } from "../_lib/assert-web-order-authorized";
import {
  Modules,
  PromotionType,
  PromotionStatus,
  ApplicationMethodType,
  ApplicationMethodTargetType,
} from "@medusajs/utils";

import { posOverrideAdjustmentsWorkflow } from "../../../../../workflows/pos-discount/workflows";
import { getDbPool } from "../../../../utils/db-pool";

/**
 * POST /admin/orders/:id/apply-discount-force
 *
 * Applies a percentage or fixed discount to a confirmed (non-draft) order
 * using the SAME native Medusa workflow as pos-discount, by temporarily
 * setting is_draft_order = true so the validation passes, then restoring it.
 *
 * This ensures discount_total shows correctly in Medusa Admin.
 *
 * Body: { discount_type: 'percent' | 'fixed', discount_value: number }
 */
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const { id } = req.params as { id: string };
  const archivedBlock = await assertOrderEditable(req.scope, id);
  if (archivedBlock) {
    res.status(409).json({ error: archivedBlock, code: "ORDER_ARCHIVED" });
    return;
  }

  // Una orden que vino de la WEB exige PIN de supervisor para editarse. El gate
  // vivia solo en la pantalla (useWebOrderLock) y comparaba en el navegador, asi
  // que un POST directo a esta ruta la editaba sin encontrar ninguna puerta.
  const webAuth = await assertWebOrderAuthorized(req.scope, id, req);
  if (webAuth.denial) {
    res.status(webAuth.denial.status).json(webAuth.denial.body);
    return;
  }
  const { discount_type, discount_value, pos_total, pos_tax_rate } =
    req.body as {
      discount_type: "percent" | "fixed";
      discount_value: number;
      pos_total?: number; // POS-computed final total in dollars (includes tax, shipping, discounts)
      pos_tax_rate?: number; // POS-computed tax rate: 0 for EXEMPT, 7 for FL. Controls which tax lines are inserted.
    };

  if (!discount_type || !discount_value) {
    return void res
      .status(400)
      .json({ message: "discount_type and discount_value are required" });
  }

  const base = `http://localhost:${process.env.PORT ?? 9000}`;
  const authHeaders: Record<string, string> = {
    Cookie: String(req.headers["cookie"] ?? ""),
    Authorization: String(req.headers["authorization"] ?? ""),
    "Content-Type": "application/json",
  };
  const logger = req.scope.resolve("logger");
  const orderModule = req.scope.resolve(Modules.ORDER) as any;
  const paymentModule = req.scope.resolve(Modules.PAYMENT) as any;
  const promotionModule = req.scope.resolve(Modules.PROMOTION) as any;

  try {
    // 1. Fetch order to get currency code and payment collections
    const orderRes = await fetch(
      `${base}/admin/orders/${id}?fields=currency_code,+payment_collections.*`,
      { headers: authHeaders }
    );
    if (!orderRes.ok)
      return void res.status(400).json({ message: "Could not fetch order" });
    const { order } = await orderRes.json();
    const paymentCollections: any[] = order?.payment_collections ?? [];

    // 2a. Delete ALL old raw line item adjustments (from previous createOrderLineItemAdjustments approach)
    //     These were NOT created through the promotion engine so they stack with the new promotion.
    // We need to re-fetch items with adjustments for cleanup
    const itemsRes = await fetch(
      `${base}/admin/orders/${id}?fields=+items.*,+items.adjustments.*`,
      { headers: authHeaders }
    );
    if (itemsRes.ok) {
      const { order: orderWithItems } = await itemsRes.json();
      for (const item of orderWithItems?.items ?? []) {
        const rawAdjs = (item.adjustments ?? []).filter(
          (a: any) => !a.tax_line_id && !a.promotion_id
        );
        if (rawAdjs.length > 0) {
          await orderModule.deleteOrderLineItemAdjustments(
            rawAdjs.map((a: any) => a.id)
          );
          logger.info(
            `[apply-discount-force] Cleaned ${rawAdjs.length} old raw adjustments from item ${item.id}`
          );
        }
      }
    }

    // 2b. Temporarily flip is_draft_order = true so native workflows accept it
    logger.info(
      `[apply-discount-force] Flipping is_draft_order=true for ${id}`
    );
    await orderModule.updateOrders(id, { is_draft_order: true });

    let promotionCode: string | null = null;
    let promotionId: string | null = null;

    try {
      // 3. Find-or-create: deterministic code from type+value to reuse existing promotions.
      const valueInt = Math.round(discount_value * 100);
      const promoCode =
        discount_type === "percent"
          ? `CPOS-PCT-${valueInt}`
          : `CPOS-FIXED-${valueInt}`;

      const [existingPromo] = await promotionModule.listPromotions(
        { code: [promoCode] },
        { select: ["id", "code", "status"] }
      );

      let promotion: { id: string; code: string };
      if (existingPromo) {
        if (existingPromo.status !== PromotionStatus.ACTIVE) {
          await promotionModule.updatePromotions([
            { id: existingPromo.id, status: PromotionStatus.ACTIVE },
          ]);
        }
        promotion = {
          id: existingPromo.id,
          code: existingPromo.code ?? promoCode,
        };
        logger.info(
          `[apply-discount-force] Reusing promotion ${promoCode} (${existingPromo.id})`
        );
      } else {
        const promotionData = {
          code: promoCode,
          type: PromotionType.STANDARD,
          status: PromotionStatus.ACTIVE,
          is_automatic: false,
          is_tax_inclusive: false,
          application_method: {
            type:
              discount_type === "percent"
                ? ApplicationMethodType.PERCENTAGE
                : ApplicationMethodType.FIXED,
            target_type: ApplicationMethodTargetType.ITEMS,
            allocation: "across" as const,
            is_tax_inclusive: false,
            value: discount_value,
            currency_code:
              discount_type === "fixed"
                ? (order.currency_code ?? "usd")
                : undefined,
          },
        };
        const { result: createdPromos } = await createPromotionsWorkflow(
          req.scope
        ).run({
          input: { promotionsData: [promotionData] },
        });
        const created = createdPromos[0];
        if (!created) throw new Error("Failed to create promotion");
        promotion = { id: created.id, code: created.code ?? promoCode };
        logger.info(`[apply-discount-force] Created promotion ${promoCode}`);
      }

      promotionCode = promoCode;
      promotionId = promotion.id;

      // 4a. Force-cancel ANY pre-existing pending order_change rows (zombies
      //     from previous failed runs would block beginDraftOrderEditWorkflow).
      //     SQL is the only reliable kill switch — cancelDraftOrderEditWorkflow
      //     can silently no-op on a half-broken edit, leaving it stuck.
      const dbUrl = process.env.DATABASE_URL;
      if (dbUrl) {
        try {
          const zPool = getDbPool();
          const zRes = await zPool.query(
            `UPDATE order_change SET status = 'canceled', canceled_at = NOW(), updated_at = NOW()
                         WHERE order_id = $1 AND status = 'pending' AND deleted_at IS NULL
                         RETURNING id`,
            [id]
          );
          if ((zRes.rowCount ?? 0) > 0) {
            logger.warn(
              `[apply-discount-force] Force-cancelled ${zRes.rowCount} zombie order_change row(s) for ${id}`
            );
          }
        } catch (e: any) {
          logger.warn(
            `[apply-discount-force] Zombie cancel failed (non-fatal): ${e.message}`
          );
        }
      }

      // 4b. Defensive workflow cancel (in case the SQL above missed an edge case)
      try {
        await cancelDraftOrderEditWorkflow(req.scope).run({
          input: { order_id: id },
        });
      } catch {
        /* no existing edit — OK */
      }

      // 5. Begin a new edit
      await beginDraftOrderEditWorkflow(req.scope).run({
        input: { order_id: id },
      });

      // 6a. SNAPSHOT existing adjustments / promo links / tax lines so we can
      //     ROLL BACK if the promotion workflow fails between wipe and confirm.
      //     Without this, a workflow failure leaves the order with ZERO
      //     adjustments — the exact bug fixed here (orphaned discount state).
      const snapshot = {
        adjustments: [] as any[],
        promoLinks: [] as any[],
        taxLines: [] as any[],
      };
      if (dbUrl) {
        const snapPool = getDbPool();
        try {
          const adjRes = await snapPool.query(
            `SELECT id, description, promotion_id, code, amount, raw_amount, provider_id, created_at, updated_at, item_id, deleted_at, is_tax_inclusive, version
                         FROM order_line_item_adjustment
                         WHERE item_id IN (SELECT item_id FROM order_item WHERE order_id = $1)`,
            [id]
          );
          snapshot.adjustments = adjRes.rows;
          const promoRes = await snapPool.query(
            `SELECT order_id, promotion_id, id, created_at, updated_at, deleted_at
                         FROM order_promotion WHERE order_id = $1`,
            [id]
          );
          snapshot.promoLinks = promoRes.rows;
          const taxRes = await snapPool.query(
            `SELECT id, description, tax_rate_id, code, rate, raw_rate, provider_id, created_at, updated_at, item_id, deleted_at
                         FROM order_line_item_tax_line
                         WHERE item_id IN (SELECT item_id FROM order_item WHERE order_id = $1)`,
            [id]
          );
          snapshot.taxLines = taxRes.rows;
          logger.info(
            `[apply-discount-force] Snapshot: ${snapshot.adjustments.length} adj, ${snapshot.promoLinks.length} promo, ${snapshot.taxLines.length} tax`
          );
        } catch (e: any) {
          logger.warn(
            `[apply-discount-force] Snapshot failed (rollback unavailable): ${e.message}`
          );
        }
      }

      // 6b. Mechanically remove old POS-DISC adjustments and `order_promotion`
      //     links so they don't stack with the freshly applied promotion.
      if (dbUrl) {
        const pool = getDbPool();
        try {
          const delAdj = await pool.query(
            `DELETE FROM order_line_item_adjustment
                         WHERE item_id IN (SELECT item_id FROM order_item WHERE order_id = $1)`,
            [id]
          );
          const delPromo = await pool.query(
            `DELETE FROM order_promotion WHERE order_id = $1`,
            [id]
          );
          // CRITICAL: Also delete stored tax lines BEFORE applying the promotion.
          // Stored tax lines inflate the promotion base in addDraftOrderPromotionWorkflow:
          // 5% × (items $52.98 + tax $3.52) = $2.82 instead of 5% × $52.98 = $2.65.
          // post-edit-sync will re-inject tax lines with the correct rate after confirmation.
          const delTax = await pool.query(
            `DELETE FROM order_line_item_tax_line
                         WHERE item_id IN (SELECT item_id FROM order_item WHERE order_id = $1)`,
            [id]
          );
          logger.info(
            `[apply-discount-force] Wiped ALL ${delAdj.rowCount} adjustments + ${delPromo.rowCount} promo links + ${delTax.rowCount} tax lines (clean slate)`
          );
        } catch (e: any) {
          logger.warn(`[apply-discount-force] DB cleanup failed: ${e.message}`);
        }
      }

      // 7-9. Apply promotion + override + confirm. If ANY step throws we
      //      restore the snapshot so the order doesn't end up with zero
      //      adjustments + a stranded `order_change` (the orphaned-discount bug).
      try {
        // 7. Apply the new promotion (now passes because is_draft_order=true)
        await addDraftOrderPromotionWorkflow(req.scope).run({
          input: { order_id: id, promo_codes: [promoCode] },
        });
        logger.info(
          `[apply-discount-force] Applied promotion ${promoCode} to order ${id}`
        );

        // 8. Override the JSON payload natively BEFORE confirm
        // This is the EXACT same magic trick we did for Estimates
        const pctVal =
          discount_type === "percent" ? discount_value / 100 : null;
        logger.info(
          `[apply-discount-force] Running posOverrideAdjustmentsWorkflow for native fractional calculation`
        );
        await posOverrideAdjustmentsWorkflow(req.scope).run({
          input: {
            order_id: id,
            promotion_code: promoCode,
            pct_discount: pctVal, // (Fixed discounts are currently handled natively by Medusa spreading mechanism, only percent needs the item-level rewrite)
          },
        });

        // 9. Confirm the edit
        await confirmDraftOrderEditWorkflow(req.scope).run({
          input: { order_id: id, confirmed_by: "pos-system" },
        });
        logger.info(
          `[apply-discount-force] Confirmed order edit via native workflow`
        );
      } catch (workflowErr: any) {
        logger.error(
          `[apply-discount-force] Workflow failed: ${workflowErr?.message}. ROLLING BACK from snapshot.`
        );
        if (dbUrl) {
          const rbPool = getDbPool();
          try {
            // Cancel the pending edit so it doesn't block subsequent runs.
            await rbPool.query(
              `UPDATE order_change SET status = 'canceled', canceled_at = NOW(), updated_at = NOW()
                             WHERE order_id = $1 AND status = 'pending' AND deleted_at IS NULL`,
              [id]
            );
            for (const r of snapshot.adjustments) {
              await rbPool.query(
                `INSERT INTO order_line_item_adjustment (id, description, promotion_id, code, amount, raw_amount, provider_id, created_at, updated_at, item_id, deleted_at, is_tax_inclusive, version)
                                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
                                 ON CONFLICT (id) DO NOTHING`,
                [
                  r.id,
                  r.description,
                  r.promotion_id,
                  r.code,
                  r.amount,
                  r.raw_amount,
                  r.provider_id,
                  r.created_at,
                  r.updated_at,
                  r.item_id,
                  r.deleted_at,
                  r.is_tax_inclusive,
                  r.version,
                ]
              );
            }
            for (const r of snapshot.promoLinks) {
              await rbPool.query(
                `INSERT INTO order_promotion (order_id, promotion_id, id, created_at, updated_at, deleted_at)
                                 VALUES ($1,$2,$3,$4,$5,$6)
                                 ON CONFLICT (order_id, promotion_id) DO NOTHING`,
                [
                  r.order_id,
                  r.promotion_id,
                  r.id,
                  r.created_at,
                  r.updated_at,
                  r.deleted_at,
                ]
              );
            }
            for (const r of snapshot.taxLines) {
              await rbPool.query(
                `INSERT INTO order_line_item_tax_line (id, description, tax_rate_id, code, rate, raw_rate, provider_id, created_at, updated_at, item_id, deleted_at)
                                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                                 ON CONFLICT (id) DO NOTHING`,
                [
                  r.id,
                  r.description,
                  r.tax_rate_id,
                  r.code,
                  r.rate,
                  r.raw_rate,
                  r.provider_id,
                  r.created_at,
                  r.updated_at,
                  r.item_id,
                  r.deleted_at,
                ]
              );
            }
            logger.warn(
              `[apply-discount-force] ROLLBACK OK: restored ${snapshot.adjustments.length} adj, ${snapshot.promoLinks.length} promo, ${snapshot.taxLines.length} tax`
            );
          } catch (rbErr: any) {
            logger.error(
              `[apply-discount-force] ROLLBACK FAILED: ${rbErr?.message}`
            );
          }
        }
        throw workflowErr;
      }

      // 10. Insert FL tax lines at the statutory rate (7%) directly via SQL.
      // updateOrderTaxLinesWorkflow would fail because tax_region.provider_id=null → AwilixError.
      // By storing rate=7, decorateCartTotals computes: 7% × (subtotal − discount_adj) = correct tax.
      // Example: 7% × ($52.96 − $2.65) = 7% × $50.31 = $3.52 ✅ — matches POS value, no overwrite needed.
      if (dbUrl) {
        const taxPool = getDbPool();
        try {
          const taxItemsRes = await taxPool.query<{ item_id: string }>(
            `SELECT DISTINCT item_id FROM order_item WHERE order_id = $1 AND deleted_at IS NULL`,
            [id]
          );
          // Delete existing tax lines first to ensure clean state
          const itemIds = taxItemsRes.rows.map((r) => r.item_id);
          if (itemIds.length > 0) {
            await taxPool.query(
              `DELETE FROM order_line_item_tax_line WHERE item_id = ANY($1)`,
              [itemIds]
            );
          }
          // Use pos_tax_rate to determine correct tax: 0 = EXEMPT, 7 = FL (or other rate)
          const effectiveRate = pos_tax_rate ?? 7;
          const taxCode = effectiveRate === 0 ? "EXEMPT" : "FL";
          const taxDesc =
            effectiveRate === 0 ? "Tax Exempt" : "Florida Sales Tax";
          const rawRate = JSON.stringify({
            value: String(effectiveRate),
            precision: 20,
          });
          for (const row of taxItemsRes.rows) {
            const taxLineId = `taxline_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            await taxPool.query(
              `INSERT INTO order_line_item_tax_line (id, item_id, code, rate, raw_rate, description, created_at, updated_at)
                             VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
              [taxLineId, row.item_id, taxCode, effectiveRate, rawRate, taxDesc]
            );
          }
          logger.info(
            `[apply-discount-force] ✅ Inserted ${taxCode} tax lines at ${effectiveRate}% for ${taxItemsRes.rows.length} items`
          );
        } catch (e: any) {
          logger.warn(
            `[apply-discount-force] Tax line insertion non-fatal: ${e.message}`
          );
        }
      }
    } finally {
      // 9. ALWAYS restore is_draft_order = false (even if something fails above)
      logger.info(
        `[apply-discount-force] Restoring is_draft_order=false for ${id}`
      );
      await orderModule
        .updateOrders(id, { is_draft_order: false })
        .catch((e: any) => {
          logger.error(
            `[apply-discount-force] CRITICAL: Could not restore is_draft_order=false for ${id}: ${e.message}`
          );
        });
    }

    // 10. Use pos_total if provided (includes POS-computed tax which Medusa doesn't apply automatically),
    //     otherwise re-fetch from Medusa
    let correctTotal: number = 0;
    if (pos_total != null && pos_total > 0) {
      correctTotal = pos_total;
      logger.info(
        `[apply-discount-force] Using POS total = ${correctTotal} (includes tax)`
      );
    } else {
      try {
        const refreshedRes = await fetch(
          `${base}/admin/orders/${id}?fields=total`,
          { headers: authHeaders }
        );
        if (refreshedRes.ok) {
          const { order: refreshedOrder } = await refreshedRes.json();
          correctTotal = refreshedOrder?.total ?? 0;
          logger.info(
            `[apply-discount-force] Refreshed order total = ${correctTotal}`
          );
        }
      } catch (e: any) {
        logger.warn(`[apply-discount-force] Re-fetch failed: ${e.message}`);
      }
    }

    // 11. Fix payment collection to match the real post-discount total
    for (const col of paymentCollections) {
      logger.info(
        `[apply-discount-force] Updating payment col ${col.id}: ${col.amount} → ${correctTotal}`
      );
      try {
        await paymentModule.updatePaymentCollections(col.id, {
          amount: correctTotal,
        });
        logger.info(
          `[apply-discount-force] ✅ Payment collection updated to ${correctTotal}`
        );
      } catch (e: any) {
        logger.error(
          `[apply-discount-force] Payment module update failed: ${e.message}`
        );
      }
    }

    // Persist canonical promo code to metadata so cleanup paths and downstream
    // readers (compute-tax, UI) stay consistent with what's in order_line_item_adjustment.
    if (promotionCode) {
      try {
        await orderModule.updateOrders(id, {
          metadata: { promotion_code: promotionCode },
        });
      } catch (e: any) {
        logger.warn(
          `[apply-discount-force] Failed to persist canonical promo code to metadata: ${e.message}`
        );
      }
    }

    res.status(200).json({
      success: true,
      promotion_code: promotionCode,
      promotion_id: promotionId,
      correct_total: correctTotal,
    });
  } catch (e: any) {
    logger.error("[apply-discount-force]", e?.message);
    res.status(500).json({ message: e?.message ?? "Failed to apply discount" });
  }
}
