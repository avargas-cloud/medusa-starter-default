import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { IPromotionModuleService } from "@medusajs/types";
import {
  beginDraftOrderEditWorkflow,
  addDraftOrderPromotionWorkflow,
  confirmDraftOrderEditWorkflow,
  cancelDraftOrderEditWorkflow,
} from "@medusajs/core-flows";
import { posOverrideAdjustmentsWorkflow } from "../../../../workflows/pos-discount/workflows";

/**
 * POST /admin/pos-discount/apply-existing
 *
 * Applies a named Medusa promotion to a draft order via the order-edit workflow,
 * then corrects the computed adjustment amounts using authoritative DB data.
 *
 * Root cause of amount mismatch:
 *   the order-edit confirm creates new line_item versions from the ORM snapshot.
 *   This snapshot may have stale qty (e.g. qty=1 when POS has qty=2) because
 *   update-item-force writes directly to DB without going through the workflow.
 *   Result: 5% × $46.13 × qty=1 = $2.31 ❌ instead of 5% × $46.13 × qty=2 = $4.61
 *
 *   Fix: after the workflow runs and writes adjustments, we recompute each
 *   adjustment amount from order_item (which has the correct qty via update-item-force)
 *   and UPDATE the adjustment rows to match.
 *
 * Linking tables:
 *   order_line_item_adjustment.item_id = line_item.id  (ordli_ prefix)
 *   order_item.item_id                 = line_item.id  (ordli_ prefix)
 *   → So adjustment.item_id = order_item.item_id — both reference the same line_item
 *
 * Body:
 *   order_id       — draft order ID
 *   promotion_code — promo code to apply
 *   promotion_id   — promo ID (optional, looked up if missing)
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runWithLockRetry<T>(
  fn: () => Promise<T>,
  retries = 3,
  delayMs = 1500
): Promise<T> {
  let lastErr: any;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      if (
        err?.message?.includes("acquire lock") ||
        err?.message?.includes("lock")
      ) {
        lastErr = err;
        if (attempt < retries) {
          await sleep(delayMs);
          continue;
        }
      }
      throw err;
    }
  }
  throw lastErr;
}

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const { order_id, promotion_code, promotion_id } = req.body as {
    order_id?: string;
    promotion_code?: string;
    promotion_id?: string;
  };

  if (!order_id) {
    res.status(400).json({ error: "order_id is required" });
    return;
  }
  if (!promotion_code) {
    res.status(400).json({ error: "promotion_code is required" });
    return;
  }

  const logger = req.scope.resolve("logger");
  const knex = req.scope.resolve("__pg_connection__");

  try {
    // ── Step 0: Resolve promotion ID + extract pct value ──────────────────
    const promotionModule = req.scope.resolve(
      "promotion"
    ) as IPromotionModuleService;
    let resolvedPromoId: string | undefined = promotion_id;
    let promoMethodValue: number | null = null;

    if (!resolvedPromoId) {
      const [promoByCode] = await promotionModule.listPromotions({
        code: [promotion_code],
      } as any);
      resolvedPromoId = promoByCode?.id;
    }

    // ── Step 1: Normalise promotion settings (ALWAYS) ─────────────────────
    if (resolvedPromoId) {
      await (promotionModule as any).updatePromotions({
        id: resolvedPromoId,
        status: "active",
        is_tax_inclusive: false,
      });

      const freshPromo = await promotionModule.retrievePromotion(
        resolvedPromoId,
        {
          relations: ["application_method"],
        }
      );
      const appMethod = (freshPromo as any).application_method;
      promoMethodValue =
        appMethod?.value != null ? Number(appMethod.value) : null;

      if (appMethod?.id) {
        await knex.raw(
          `
                    UPDATE promotion_application_method
                    SET target_type = 'items', updated_at = NOW()
                    WHERE id = ? AND deleted_at IS NULL
                `,
          [appMethod.id]
        );

        // ORM cache bust
        await promotionModule.retrievePromotion(resolvedPromoId, {
          relations: ["application_method"],
        });
      }
      logger.info(
        `[POS apply-existing] Normalised ${promotion_code} → active, is_tax_inclusive=false, target_type=items, pct=${promoMethodValue}`
      );
    } else {
      // Fallback: read pct from DB
      const pgPromo = await knex.raw(
        `
                SELECT am.value FROM promotion p
                JOIN promotion_application_method am ON am.promotion_id = p.id
                WHERE p.code = ? AND p.deleted_at IS NULL AND am.deleted_at IS NULL LIMIT 1
            `,
        [promotion_code]
      );
      promoMethodValue = pgPromo.rows[0] ? Number(pgPromo.rows[0].value) : null;
      logger.warn(
        `[POS apply-existing] promotionId not resolved for ${promotion_code}, pct=${promoMethodValue}`
      );
    }

    // ── Step 2: Cancel any open order edits ───────────────────────────────
    try {
      await cancelDraftOrderEditWorkflow(req.scope).run({
        input: { order_id },
      });
      await sleep(500);
    } catch {
      /* No open edit — fine */
    }

    // ── Step 3: Begin a new draft order edit ─────────────────────────────
    await runWithLockRetry(
      () => beginDraftOrderEditWorkflow(req.scope).run({ input: { order_id } }),
      3,
      1500
    );
    logger.info(`[POS apply-existing] Began draft order edit`);

    // ── Step 4: Apply the promotion via workflow ───────────────────────────
    await addDraftOrderPromotionWorkflow(req.scope).run({
      input: { order_id, promo_codes: [promotion_code] },
    });
    logger.info(`[POS apply-existing] Applied ${promotion_code} via workflow`);

    // ── Step 5 (NEW NATIVE): Override adjustments BEFORE confirmation ──────
    // Intercept the Draft Edit Payload and overwrite all the bad prorated numbers.
    await posOverrideAdjustmentsWorkflow(req.scope).run({
      input: {
        order_id,
        promotion_code,
        pct_discount: promoMethodValue ? promoMethodValue / 100 : null,
      },
    });
    logger.info(
      `[POS apply-existing] Ran posOverrideAdjustmentsWorkflow to patch JSON adjustments payload`
    );

    /* --- LEGACY SQL FORCE LOGIC (Commented for fallback per user request) ---
        // ── Step 5: Soft-delete ALL current active adjustments for this promo ──
        try {
            const del = await knex.raw(\`
                UPDATE order_line_item_adjustment
                SET deleted_at = NOW()
                WHERE deleted_at IS NULL
                  AND code = ?
                  AND item_id IN (
                      SELECT DISTINCT item_id FROM order_item
                      WHERE order_id = ?
                  )
            \`, [promotion_code, order_id])
            logger.info(\`[POS apply-existing] Pre-confirm: soft-deleted \${del.rowCount ?? 0} existing adjustment(s)\`)
        } catch (e: any) {
            logger.warn(\`[POS apply-existing] Pre-confirm soft-delete non-fatal: \${e.message}\`)
        }
        ------------------------------------------------------------------------- */

    // ── Step 6: Confirm the edit ──────────────────────────────────────────
    // Materialises ITEM_ADJUSTMENTS_REPLACE → NEW order_line_item_adjustment rows
    // with workflow-computed amounts (may be wrong due to ORM snapshot qty mismatch)
    // BUT we fixed the JSON payload in Step 5, so decorateCartTotals natively succeeds.
    await confirmDraftOrderEditWorkflow(req.scope).run({
      input: {
        order_id,
        confirmed_by: (req as any).auth_context?.actor_id ?? "pos-system",
      },
    });
    logger.info(`[POS apply-existing] Confirmed draft order edit`);

    /* --- LEGACY SQL FORCE LOGIC (Commented for fallback per user request) ---
        // ── Step 7: Correct adjustment amounts from authoritative order_item ───
        if (promoMethodValue != null && promoMethodValue > 0) {
            try {
                const pct = promoMethodValue / 100

                // Get all active adjustments for this promo on this order
                const adjResult = await knex.raw(\`
                    SELECT a.id, a.item_id, a.amount
                    FROM order_line_item_adjustment a
                    WHERE a.code = ?
                      AND a.deleted_at IS NULL
                      AND a.item_id IN (
                          SELECT DISTINCT item_id FROM order_item WHERE order_id = ?
                      )
                \`, [promotion_code, order_id])

                const adjRows: Array<{ id: string; item_id: string; amount: number }> = adjResult.rows
                logger.info(\`[POS apply-existing] Found \${adjRows.length} active adjustment(s) after confirm\`)

                for (const adj of adjRows) {
                    // Get latest order_item version...
                    const oiResult = await knex.raw(\`
                        SELECT unit_price, quantity
                        FROM order_item
                        WHERE item_id = ? AND order_id = ?
                        ORDER BY version DESC
                        LIMIT 1
                    \`, [adj.item_id, order_id])

                    if (oiResult.rows.length > 0) {
                        const { unit_price, quantity } = oiResult.rows[0]
                        const correct = Number((Number(unit_price) * Number(quantity) * pct).toFixed(2))

                        const rawAmountJson = JSON.stringify({ value: String(correct), precision: 20 })
                        await knex.raw(\`
                            UPDATE order_line_item_adjustment
                            SET amount = ?, raw_amount = ?::jsonb, updated_at = NOW()
                            WHERE id = ? AND deleted_at IS NULL
                        \`, [correct, rawAmountJson, adj.id])
                        logger.info(\`[POS apply-existing] Corrected adj \${adj.id}\`)
                    } else {
                        logger.warn(\`[POS apply-existing] No order_item found for item_id=\${adj.item_id}\`)
                    }
                }
            } catch (e: any) {
                logger.warn(\`[POS apply-existing] Adjustment correction non-fatal: \${e.message}\`)
            }
        }

        // ── Step 8: Hard-delete all stale rows ────────────────────────────────
        try {
            const adjDel = await knex.raw(\`
                DELETE FROM order_line_item_adjustment
                WHERE deleted_at IS NOT NULL
                  AND item_id IN (
                      SELECT DISTINCT item_id FROM order_item WHERE order_id = ?
                  )
            \`, [order_id])
            logger.info(\`[POS apply-existing] Hard-deleted \${adjDel.rowCount ?? 0} stale adjustment row(s)\`)

            const ocaDel = await knex.raw(\`
                DELETE FROM order_change_action
                WHERE order_change_id IN (
                    SELECT id FROM order_change WHERE order_id = ?
                    AND id != (SELECT id FROM order_change WHERE order_id = ? ORDER BY created_at DESC LIMIT 1)
                )
            \`, [order_id, order_id])

            const ocDel = await knex.raw(\`
                DELETE FROM order_change WHERE order_id = ?
                AND id != (SELECT id FROM order_change WHERE order_id = ? ORDER BY created_at DESC LIMIT 1)
            \`, [order_id, order_id])

            const oiDel = await knex.raw(\`
                DELETE FROM order_item
                WHERE order_id = ?
                  AND (item_id, version) NOT IN (
                      SELECT item_id, MAX(version) FROM order_item WHERE order_id = ? GROUP BY item_id
                  )
            \`, [order_id, order_id])

            const osDel = await knex.raw(\`
                DELETE FROM order_summary WHERE order_id = ?
                AND version != (SELECT MAX(version) FROM order_summary WHERE order_id = ?)
            \`, [order_id, order_id])

        } catch (e: any) {
            logger.warn(\`[POS apply-existing] Hard-delete cleanup non-fatal: \${e.message}\`)
        }
        ------------------------------------------------------------------------- */

    res.status(200).json({ success: true });
  } catch (err: any) {
    logger.error(`[POS apply-existing] Error: ${err.message}`);
    res.status(500).json({ error: err.message || "Failed to apply promotion" });
  }
}
