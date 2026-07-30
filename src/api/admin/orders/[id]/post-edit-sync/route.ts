import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { assertOrderEditable } from "../_lib/assert-order-editable";
import { assertWebOrderAuthorized } from "../_lib/assert-web-order-authorized";
import { ContainerRegistrationKeys } from "@medusajs/utils";
import { syncInventoryItemToMeiliSearchWorkflow } from "../../../../../workflows/sync-inventory-item-meilisearch";

import { parseSalesRepInitials } from "../../../../../lib/quickbooks/parse-sales-rep";
import { withQbSerialized } from "../../../../../lib/quickbooks/qb-serializer";
import { reconcileOrderReservations } from "../../../../../lib/finance/reconcile-order-reservations";
import { getDbPool } from "../../../../utils/db-pool";
import {
  replaceOrderTaxLines,
  resolvePatchedOrderTotal,
  resolveQbParityTax,
  loadOrderMoneyBase,
  isZeroTaxSafe,
} from "../../../../../lib/order-money/order-tax-lines";

/**
 * POST /admin/orders/:id/post-edit-sync
 *
 * Post-edit reconciliation for confirmed (non-draft) SALES orders.
 * Called after any force-update to items.
 *
 * Steps:
 *  1. DISCOUNT — apply-discount-force applies discount to ALL items + fixes payment collection
 *  (Allocation step removed — regular orders without inventory items cannot be allocated)
 *
 * Body: { promotion_code?, promotion_id?, discount_type?, discount_value? }
 *
 * NOTE: addDraftOrderPromotionWorkflow (Medusa's native promotion workflow) cannot run
 * on regular sales orders (requires is_draft_order=true). So we use apply-discount-force
 * which directly creates Order Module adjustments. Medusa admin discount_total won't
 * reflect these, but the payment collection will be correct.
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
  const {
    discount_type,
    discount_value,
    pos_discount_amount,
    pos_total,
    pos_tax_amount,
    pos_tax_rate,
    shipping_address,
    billing_address,
  } = req.body as {
    discount_type?: string;
    discount_value?: number; // Raw discount value: percent rate (e.g. 5) OR fixed dollar amount
    pos_discount_amount?: number; // POS-computed dollar discount amount for reconciliation (e.g. 2.65)
    pos_total?: number; // POS-computed final total in dollars (includes tax, shipping, discounts)
    pos_tax_amount?: number; // POS-computed tax in dollars
    pos_tax_rate?: number; // POS-computed tax rate (e.g. 7)
    shipping_address?: Record<string, any>;
    billing_address?: Record<string, any>;
  };

  const base = `http://localhost:${process.env.PORT ?? 9000}`;
  const authHeaders: Record<string, string> = {
    Cookie: String(req.headers["cookie"] ?? ""),
    Authorization: String(req.headers["authorization"] ?? ""),
    "Content-Type": "application/json",
  };
  const logger = req.scope.resolve("logger");
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY);
  const results: Record<string, any> = {};

  // ── Update Order Addresses Natively via DB (Workaround for Medusa v2 native POST bug)
  if (shipping_address || billing_address) {
    const pool = getDbPool();
    try {
      const addrRes = await pool.query<{
        shipping_address_id: string;
        billing_address_id: string;
      }>(
        `SELECT shipping_address_id, billing_address_id FROM "order" WHERE id = $1`,
        [id]
      );
      const { shipping_address_id, billing_address_id } = addrRes.rows[0] || {};

      const updateAddr = async (addrId: string, data: Record<string, any>) => {
        if (!addrId || !data) return;
        await pool.query(
          `UPDATE order_address SET 
                        first_name = $1, last_name = $2, company = $3, address_1 = $4, address_2 = $5,
                        city = $6, province = $7, postal_code = $8, country_code = $9, phone = $10,
                        updated_at = NOW()
                     WHERE id = $11`,
          [
            data.first_name || "",
            data.last_name || "",
            data.company || "",
            data.address_1 || "",
            data.address_2 || "",
            data.city || "",
            data.province || "",
            data.postal_code || "",
            data.country_code || "",
            data.phone || "",
            addrId,
          ]
        );
      };

      if (shipping_address && shipping_address_id) {
        await updateAddr(shipping_address_id, shipping_address);
        logger.info(
          `[post-edit-sync] ✅ Force-updated shipping_address on order ${id}`
        );
      }
      if (billing_address && billing_address_id) {
        await updateAddr(billing_address_id, billing_address);
        logger.info(
          `[post-edit-sync] ✅ Force-updated billing_address on order ${id}`
        );
      }
    } catch (e: any) {
      logger.warn(
        `[post-edit-sync] ⚠️ Failed to force-update addresses: ${e.message}`
      );
    }
  }

  // ── Apply discount + fix payment collection ───────────────────────────────
  if (discount_type && discount_value && discount_value > 0) {
    try {
      const dr = await fetch(
        `${base}/admin/orders/${id}/apply-discount-force`,
        {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({
            discount_type,
            discount_value,
            pos_total,
            pos_tax_rate,
          }),
        }
      );
      const dj = await dr.json().catch(() => ({}));
      if (dr.ok) {
        logger.info(
          `[post-edit-sync] ✅ apply-discount-force: ${JSON.stringify(dj)}`
        );
        results.discount = dj;
      } else {
        logger.error(
          `[post-edit-sync] apply-discount-force failed: ${JSON.stringify(dj)}`
        );
        results.discount_error = dj?.message;
      }
    } catch (e: any) {
      logger.error(`[post-edit-sync] apply-discount-force threw: ${e.message}`);
    }
  } else {
    // No discount — still fix payment collection to current order total
    try {
      const { data } = await query.graph({
        entity: "order",
        fields: ["total", "payment_collections.*"],
        filters: { id },
      });
      const order = data?.[0];

      if (order) {
        // Use POS total if provided (includes tax), otherwise use Medusa's order total
        const correctTotal: number =
          pos_total != null && pos_total > 0 ? pos_total : (order?.total ?? 0);
        const cols: any[] = order?.payment_collections ?? [];
        logger.info(
          `[post-edit-sync] No discount — fixing payment: total=${correctTotal}, cols=${cols.length}`
        );
        const paymentModule = req.scope.resolve("payment" as any) as any;

        // Parallelize payment collection updates
        await Promise.all(
          cols.map((col) =>
            paymentModule.updatePaymentCollections(col.id, {
              amount: correctTotal,
            })
          )
        );
        logger.info(
          `[post-edit-sync] ✅ Payment(s) updated to $${correctTotal}`
        );
        results.payment_fixed = correctTotal;
      }
    } catch (e: any) {
      logger.warn(`[post-edit-sync] Payment fix failed: ${e.message}`);
    }
  }

  // ── Apply Tax to Order Summary & Tax Lines ──────────────────────────────
  if (pos_tax_amount != null) {
    const dbUrl = process.env.DATABASE_URL;
    if (dbUrl) {
      const pool = getDbPool();
      try {
        // 1. Fetch current Medusa-stored tax_total (BEFORE our injection) natively.
        //    NULL means "could not read", which is NOT the same as zero: this
        //    value is the tax already baked into original_order_total, and the
        //    total below is derived by subtracting it. Defaulting a failed read
        //    to 0 is what let the tax get counted twice on 43 orders.
        let calculatedTax: number | null = null;
        try {
          const { data } = await query.graph({
            entity: "order",
            fields: ["tax_total"],
            filters: { id },
          });
          const raw = data?.[0]?.tax_total;
          calculatedTax = raw == null ? 0 : Number(raw);
          if (!Number.isFinite(calculatedTax)) calculatedTax = null;
        } catch {
          /* leave null — the summary write below refuses rather than guesses */
        }

        // Use the statutory tax rate (7% FL). Do NOT back-calculate from gross subtotal.
        const effectiveRate = pos_tax_rate ?? 7;

        logger.info(
          `[post-edit-sync] CALCULATED TAX = ${calculatedTax === null ? "UNREADABLE" : `$${calculatedTax.toFixed(2)}`} | POS TAX = $${pos_tax_amount.toFixed(2)}`
        );
        if (
          calculatedTax !== null &&
          Math.abs(calculatedTax - pos_tax_amount) > 0.005
        ) {
          logger.warn(
            `[post-edit-sync] ⚠️  TAX OVERWRITE: Medusa=$${calculatedTax.toFixed(2)} → POS=$${pos_tax_amount.toFixed(2)} (rate=${effectiveRate}%)`
          );
        }

        // 2. Rewrite the tax lines PER LINE. This block used to insert one line
        //    at `effectiveRate` for every item of the order with no `taxable`
        //    check, which taxed exempt lines: S10732 landed at $156.62 against
        //    QuickBooks' $154.24, the $2.38 being 7% charged on an exempt $34
        //    service. QB itself had it right — it received `Services → Non`.
        const taxRewrite = await replaceOrderTaxLines(pool, id, effectiveRate);
        const itemIds = taxRewrite.itemIds;
        if (itemIds.length > 0) {
          logger.info(
            `[post-edit-sync] ✅ Tax lines rewritten: ${taxRewrite.taxedItemIds.length} taxed @ ${effectiveRate}%, ` +
              `${taxRewrite.exemptItemIds.length} exempt (POS tax $${pos_tax_amount})`
          );
        }

        // 3. Update order_summary JSONB with correct totals
        const summaryRes = await pool.query<{
          id: string;
          totals: any;
          version: number;
        }>(
          `SELECT id, totals, version FROM order_summary
                     WHERE order_id = $1 AND deleted_at IS NULL
                     ORDER BY version DESC LIMIT 1`,
          [id]
        );
        if (summaryRes.rows[0]) {
          const { id: summaryId, totals } = summaryRes.rows[0];

          // Prefer pos_discount_amount (POS dollar truth); fall back to fixed discount_value.
          const forcedDiscount =
            pos_discount_amount && pos_discount_amount > 0
              ? pos_discount_amount
              : discount_value &&
                  discount_value > 0 &&
                  discount_type !== "percent"
                ? discount_value
                : totals.discount_total || 0;

          // The old formula was `original_order_total + pos_tax − discount`, and
          // `original_order_total` carries the native tax on SOME orders — 43 of
          // them came out overstated by a flat 6.535–6.563%, i.e. 7/107, the
          // signature of a tax added on a base that already had one. It is NOT a
          // reliable input either way (a converted draft stores it with the tax
          // held separately), so the total is derived from the order's own lines
          // and shipping instead of by arithmetic on another derived figure.
          const moneyBase = await loadOrderMoneyBase(pool, id);
          const resolved = resolvePatchedOrderTotal({
            base: moneyBase,
            posTaxAmount: pos_tax_amount,
            discount: forcedDiscount,
          });

          if (!resolved.ok) {
            logger.error(
              `[post-edit-sync] ❌ Refusing to patch order_summary ${summaryId}: ${resolved.reason}. ` +
                `Leaving the previous total in place — this figure is the clamp ceiling for ` +
                `order_money_projection, so a wrong one silently zeroes a real deposit.`
            );
            results.tax_error = resolved.reason;
            throw new Error(`order total not derivable: ${resolved.reason}`);
          }
          for (const w of resolved.warnings) {
            logger.warn(`[post-edit-sync] ⚠️  ${w}`);
          }
          // `tax_total` is not display-only: the QB handlers choose the header
          // tax code with `hasTax = tax_total > 0`, and a zero sends the whole
          // document as Exempt so QuickBooks charges nothing on any line.
          //
          // The first version of this guard kept the PREVIOUS tax_total when the
          // POS sent 0 on an order that still had taxable lines. That protected
          // the header and produced an incoherent row: a total derived with zero
          // tax stored next to a positive tax_total left over from an earlier
          // state. Recompute instead — from the same base the total came from,
          // so the two agree by construction.
          let taxTotalToWrite = pos_tax_amount;
          if (pos_tax_amount === 0 && !isZeroTaxSafe(taxRewrite)) {
            const recomputed = resolveQbParityTax(
              moneyBase,
              forcedDiscount,
              effectiveRate
            );
            taxTotalToWrite = recomputed.tax;
            logger.warn(
              `[post-edit-sync] ⚠️  POS sent tax 0 with ${taxRewrite.taxedItemIds.length} taxable ` +
                `line(s); recomputed $${taxTotalToWrite} on a base of $${recomputed.taxableBase} @ ${effectiveRate}%.`
            );
          }

          // Whatever the tax ends up being, the total has to include THAT number.
          // Deriving the total with one tax and storing another is the shape this
          // whole change exists to remove.
          const newAccountingTotal =
            taxTotalToWrite === pos_tax_amount
              ? resolved.total
              : (() => {
                  const redo = resolvePatchedOrderTotal({
                    base: moneyBase,
                    posTaxAmount: taxTotalToWrite,
                    discount: forcedDiscount,
                  });
                  return redo.ok ? redo.total : resolved.total;
                })();

          await pool.query(
            `UPDATE order_summary SET totals = $1, updated_at = NOW() WHERE id = $2`,
            [
              JSON.stringify({
                ...totals,
                tax_total: taxTotalToWrite,
                raw_tax_total: {
                  value: String(taxTotalToWrite),
                  precision: 20,
                },
                // Force the bottom-line variables so Admin UI doesn't look crazy
                accounting_total: newAccountingTotal,
                raw_accounting_total: {
                  value: String(newAccountingTotal),
                  precision: 20,
                },
                current_order_total: newAccountingTotal,
                raw_current_order_total: {
                  value: String(newAccountingTotal),
                  precision: 20,
                },
                pending_difference: newAccountingTotal,
                raw_pending_difference: {
                  value: String(newAccountingTotal),
                  precision: 20,
                },
              }),
              summaryId,
            ]
          );
          logger.info(
            `[post-edit-sync] ✅ Injected $${pos_tax_amount} tax to order_summary ${summaryId} and fixed accounting_total`
          );
          results.tax_injected = pos_tax_amount;
        }
      } catch (e: any) {
        logger.error(`[post-edit-sync] Tax injection failed: ${e.message}`);
        results.tax_error = e.message;
      }
    }
  }

  // ── Apply Hard Wipe of Stale Data ───────────────────────────────────────
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    const pool = getDbPool();
    try {
      // 1a. Delete soft-deleted adjustments
      const adjDel = await pool.query(
        `DELETE FROM order_line_item_adjustment
                 WHERE deleted_at IS NOT NULL
                   AND item_id IN (SELECT DISTINCT item_id FROM order_item WHERE order_id = $1)`,
        [id]
      );
      logger.info(
        `[post-edit-sync] 🧹 Hard-deleted ${adjDel.rowCount ?? 0} stale adjustment row(s)`
      );

      // 1b. Delete adjustments stuck at old order_item versions. Medusa joins
      //     adjustments → order_item by version, so a mismatch makes them
      //     invisible (and inflates `discount_total = 0` on the live order).
      const adjVerDel = await pool.query(
        `DELETE FROM order_line_item_adjustment
                 WHERE item_id IN (SELECT DISTINCT item_id FROM order_item WHERE order_id = $1)
                   AND version != (SELECT MAX(version) FROM order_item WHERE order_id = $2)`,
        [id, id]
      );
      logger.info(
        `[post-edit-sync] 🧹 Hard-deleted ${adjVerDel.rowCount ?? 0} adjustment(s) at stale versions`
      );

      // 2. Delete old order_change_action rows (keep only latest order_change)
      const ocaDel = await pool.query(
        `DELETE FROM order_change_action
                 WHERE order_change_id IN (
                     SELECT id FROM order_change WHERE order_id = $1
                     AND id != (SELECT id FROM order_change WHERE order_id = $2 ORDER BY created_at DESC LIMIT 1)
                 )`,
        [id, id]
      );
      logger.info(
        `[post-edit-sync] 🧹 Hard-deleted ${ocaDel.rowCount ?? 0} stale order_change_action row(s)`
      );

      // 3. Delete old order_change rows (keep only latest)
      const ocDel = await pool.query(
        `DELETE FROM order_change WHERE order_id = $1
                 AND id != (SELECT id FROM order_change WHERE order_id = $2 ORDER BY created_at DESC LIMIT 1)`,
        [id, id]
      );
      logger.info(
        `[post-edit-sync] 🧹 Hard-deleted ${ocDel.rowCount ?? 0} stale order_change row(s)`
      );

      // 4. Delete old order_item versions (keep only latest version per item)
      const oiDel = await pool.query(
        `DELETE FROM order_item
                 WHERE order_id = $1
                   AND (item_id, version) NOT IN (
                       SELECT item_id, MAX(version) FROM order_item WHERE order_id = $2 GROUP BY item_id
                   )`,
        [id, id]
      );
      logger.info(
        `[post-edit-sync] 🧹 Hard-deleted ${oiDel.rowCount ?? 0} stale order_item version(s)`
      );

      // 5. Delete old order_summary versions (keep only latest)
      const osDel = await pool.query(
        `DELETE FROM order_summary WHERE order_id = $1
                 AND version != (SELECT MAX(version) FROM order_summary WHERE order_id = $2)`,
        [id, id]
      );
      logger.info(
        `[post-edit-sync] 🧹 Hard-deleted ${osDel.rowCount ?? 0} stale order_summary version(s)`
      );
    } catch (e: any) {
      logger.warn(
        `[post-edit-sync] 🧹 Hard-wipe cleanup non-fatal: ${e.message}`
      );
    }
  }

  // ── Discount Reconciliation (Safety Net) ─────────────────────────────────
  // pos_discount_amount = POS-computed dollar amount (e.g. $2.65 or 0), ALWAYS provided when discount exists or is removed.
  // If not available, fall back to discount_value only when it is a fixed dollar amount (not a percent rate).
  const reconDiscountAmt =
    pos_discount_amount !== undefined && pos_discount_amount !== null
      ? pos_discount_amount
      : discount_value && discount_value > 0 && discount_type === "fixed"
        ? discount_value
        : undefined;

  if (reconDiscountAmt !== undefined && reconDiscountAmt >= 0) {
    try {
      // Fetch adjustments alongside discount_total — Medusa v2's decorateCartTotals
      // returns 0 when adjustments aren't eagerly loaded into the response, which
      // would mask a real discount and skip the delete-on-zero branch below.
      const recheckRes = await fetch(
        `${base}/admin/orders/${id}?fields=discount_total,metadata,+items.adjustments.*`,
        { headers: authHeaders }
      );
      if (recheckRes.ok) {
        const { order: recheckOrder } = await recheckRes.json();
        // Authoritative discount = sum of live adjustments. Falls back to
        // Medusa's `discount_total` if items aren't returned for any reason.
        const liveAdjSum: number = Array.isArray(recheckOrder?.items)
          ? recheckOrder.items.reduce(
              (s: number, it: any) =>
                s +
                ((it?.adjustments ?? []) as any[])
                  .filter((a: any) => !a?.tax_line_id)
                  .reduce((a: number, b: any) => a + Number(b?.amount ?? 0), 0),
              0
            )
          : 0;
        const medusaDiscount =
          liveAdjSum > 0
            ? liveAdjSum
            : Number(recheckOrder?.discount_total ?? 0);
        const posDiscount = Number(reconDiscountAmt);
        logger.info(
          `[post-edit-sync] CALCULATED DISCOUNT = $${medusaDiscount.toFixed(2)} | POS ORDER DISCOUNT = $${posDiscount.toFixed(2)}`
        );
        if (Math.abs(medusaDiscount - posDiscount) > 0.005) {
          logger.warn(
            `[post-edit-sync] ⚠️ DISCOUNT OVERWRITE: Medusa=$${medusaDiscount.toFixed(2)} → POS=$${posDiscount.toFixed(2)}`
          );
          const discPool = getDbPool();
          try {
            const adjRes = await discPool.query<{ id: string; amount: string }>(
              `SELECT olia.id, olia.amount::text
                             FROM order_line_item_adjustment olia
                             WHERE olia.item_id IN (SELECT oi.item_id FROM order_item oi WHERE oi.order_id = $1)
                             AND olia.deleted_at IS NULL`,
              [id]
            );
            const adjs = adjRes.rows;
            if (adjs.length > 0) {
              if (posDiscount === 0) {
                // FULL DELETE OF ADJUSTMENTS TO REMOVE DISCOUNT
                await discPool.query(
                  `DELETE FROM order_line_item_adjustment
                                     WHERE item_id IN (SELECT oi.item_id FROM order_item oi WHERE oi.order_id = $1)`,
                  [id]
                );
                logger.info(
                  `[post-edit-sync] ✅ Forced discount to ZERO: Deleted ${adjs.length} adjustments`
                );
                results.discount_forced = 0;
              } else {
                const totalAdj = adjs.reduce((s, r) => s + Number(r.amount), 0);
                for (const adj of adjs) {
                  const proportion =
                    totalAdj > 0
                      ? Number(adj.amount) / totalAdj
                      : 1 / adjs.length;
                  const newAmt = Number((proportion * posDiscount).toFixed(6));
                  const rawAmt = JSON.stringify({
                    value: String(newAmt),
                    precision: 20,
                  });
                  await discPool.query(
                    `UPDATE order_line_item_adjustment SET amount = $1, raw_amount = $2, updated_at = NOW() WHERE id = $3`,
                    [newAmt, rawAmt, adj.id]
                  );
                }
                logger.info(
                  `[post-edit-sync] ✅ Forced discount: ${adjs.length} adjustments corrected to sum $${posDiscount}`
                );
                results.discount_forced = posDiscount;
              }
            } else if (posDiscount > 0) {
              // SAFETY NET: zero adjustments but POS reports a non-zero discount.
              // This means apply-discount-force failed silently (orphaned-discount bug).
              // Recreate adjustments here so Medusa's `total` = computed_total again.
              logger.warn(
                `[post-edit-sync] ⚠️ ORPHANED-DISCOUNT RECOVERY: 0 adjustments but posDiscount=$${posDiscount}. Creating fallback prorrated adjustments.`
              );
              const linesRes = await discPool.query<{
                item_id: string;
                line_subtotal: string;
              }>(
                `SELECT oi.item_id, (oi.quantity * oli.unit_price)::text AS line_subtotal
                                 FROM order_item oi
                                 JOIN order_line_item oli ON oli.id = oi.item_id
                                 WHERE oi.order_id = $1 AND oi.deleted_at IS NULL`,
                [id]
              );
              const lines = linesRes.rows;
              const totalSub = lines.reduce(
                (s, r) => s + Number(r.line_subtotal),
                0
              );
              if (lines.length > 0 && totalSub > 0) {
                const promoCode =
                  (recheckOrder?.metadata?.promotion_code as
                    | string
                    | undefined) ??
                  `CPOS-FALLBACK-${Math.round(posDiscount * 100)}`;
                const promoLookup = await discPool.query<{ id: string }>(
                  `SELECT id FROM promotion WHERE code = $1 LIMIT 1`,
                  [promoCode]
                );
                const promoId: string | null =
                  promoLookup.rows[0]?.id ?? null;

                for (const ln of lines) {
                  const proportion = Number(ln.line_subtotal) / totalSub;
                  const adjAmt = Number(
                    (proportion * posDiscount).toFixed(6)
                  );
                  const rawAmt = JSON.stringify({
                    value: String(adjAmt),
                    precision: 20,
                  });
                  const adjId = `adj_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
                  await discPool.query(
                    `INSERT INTO order_line_item_adjustment
                                         (id, item_id, code, amount, raw_amount, promotion_id, description, is_tax_inclusive, version, created_at, updated_at)
                                     VALUES ($1, $2, $3, $4, $5, $6, $7, false, 1, NOW(), NOW())`,
                    [
                      adjId,
                      ln.item_id,
                      promoCode,
                      adjAmt,
                      rawAmt,
                      promoId,
                      "POS Discount (recovered)",
                    ]
                  );
                }
                if (promoId) {
                  const linkId = `ordpr_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
                  await discPool.query(
                    `INSERT INTO order_promotion (id, order_id, promotion_id, created_at, updated_at)
                                     VALUES ($1, $2, $3, NOW(), NOW())
                                     ON CONFLICT (order_id, promotion_id) DO NOTHING`,
                    [linkId, id, promoId]
                  );
                }
                logger.info(
                  `[post-edit-sync] ✅ Recovery created ${lines.length} prorrated adjustments summing $${posDiscount} (promo=${promoCode})`
                );
                results.discount_recovered = posDiscount;
              }
            }

            // CRITICAL: Also update order_summary so the admin DISPLAY shows the correct discount_total.
            const sumRes2 = await discPool.query<{ id: string; totals: any }>(
              `SELECT id, totals FROM order_summary WHERE order_id = $1 AND deleted_at IS NULL ORDER BY version DESC LIMIT 1`,
              [id]
            );
            if (sumRes2.rows[0]) {
              const { id: sumId2, totals: sumTotals2 } = sumRes2.rows[0];
              await discPool.query(
                `UPDATE order_summary SET totals = $1, updated_at = NOW() WHERE id = $2`,
                [
                  JSON.stringify({
                    ...sumTotals2,
                    discount_total: posDiscount,
                    raw_discount_total: {
                      value: String(posDiscount),
                      precision: 20,
                    },
                  }),
                  sumId2,
                ]
              );
              logger.info(
                `[post-edit-sync] ✅ Order summary discount_total corrected to $${posDiscount}`
              );
            }
          } finally {
            // shared pool — do NOT call pool.end()
          }
        } else {
          logger.info(`[post-edit-sync] ✅ DISCOUNT OK — no overwrite needed`);
          results.discount_ok = medusaDiscount;
        }
      }
    } catch (e: any) {
      logger.warn(
        `[post-edit-sync] Discount reconciliation non-fatal: ${e.message}`
      );
    }
  }
  // ── Update Allocations (Sync Inventory Reservations) ─────────────────────
  try {
    const allocRes = await fetch(`${base}/admin/orders/${id}/allocate-items`, {
      method: "POST",
      headers: authHeaders,
      body: "{}",
    });
    if (allocRes.ok) {
      results.allocations = await allocRes.json();
      logger.info(`[post-edit-sync] ✅ Allocations updated successfully!`);
    } else {
      logger.warn(
        `[post-edit-sync] ⚠️ Failed to update allocations: ${allocRes.status}`
      );
    }
  } catch (e: any) {
    logger.warn(`[post-edit-sync] Failed to sync allocations: ${e.message}`);
  }

  // ── Meilisearch Inventory Sync (incremental — only affected variants) ───────
  setImmediate(async () => {
    try {
      const { data: itemsData } = await query.graph({
        entity: "order",
        fields: ["items.variant_id"],
        filters: { id },
      });
      const variantIds: string[] = [
        ...new Set(
          (itemsData?.[0]?.items ?? [])
            .map((item: any) => item.variant_id)
            .filter(Boolean)
        ),
      ];
      if (variantIds.length > 0) {
        for (const variantId of variantIds) {
          await syncInventoryItemToMeiliSearchWorkflow(req.scope).run({
            input: { variantId },
          });
        }
        logger.info(
          `[post-edit-sync] ✅ Meilisearch inventory synced for ${variantIds.length} variant(s)`
        );
      }
    } catch (meiliErr: any) {
      logger.warn(
        `[post-edit-sync] Meilisearch incremental sync failed (non-fatal): ${meiliErr.message}`
      );
    }
  });

  // ── Update QuickBooks Sales Order / Estimate (Sync Edits) ───────────────────
  try {
    const qbEnabled = process.env.QB_ORDER_FLOW_ENABLED === "true";
    let skipQb = (req.body as any).skip_qb === true;

    // Override skip_qb when the order needs a new QB Sales Order after a void.
    // This is a one-time repair: invoice was voided but no SO exists — the backend
    // must create one regardless of whether items changed in this save.
    if (qbEnabled && skipQb) {
      try {
        const { getDbPool: _pool } = require("../../../../utils/db-pool");
        const { rows: peekRows } = await _pool().query(
          `SELECT (
             (o.metadata->>'qb_sales_order_txn_id' IS NULL)
             AND ((o.metadata->'qb_sales_order'->>'txn_id') IS NULL)
             AND (o.metadata->>'qb_estimate_txn_id' IS NULL)
             AND ((o.metadata->'qb_estimate'->>'txn_id') IS NULL)
             AND EXISTS (
               SELECT 1 FROM pos_invoice pi
               WHERE pi.order_id = $1 AND pi.status = 'voided' AND pi.deleted_at IS NULL
             )
           ) AS needs_so_repair
           FROM "order" o WHERE o.id = $1`,
          [id]
        );
        if (peekRows[0]?.needs_so_repair === true) {
          skipQb = false;
          logger.info(
            `[post-edit-sync] 🔧 skip_qb overridden — voided invoice detected, forcing SO repair for order ${id}`
          );
        }
      } catch (peekErr: any) {
        logger.warn(
          `[post-edit-sync] Could not peek order QB state: ${peekErr.message}`
        );
      }
    }

    if (qbEnabled && !skipQb) {
      const { data: qbOrderData } = await query.graph({
        entity: "order",
        fields: [
          "id",
          "display_id",
          "version",
          "metadata",
          "items.*",
          "items.variant.*",
          "items.variant.metadata",
        ],
        filters: { id },
      });
      const qbOrder = qbOrderData?.[0];
      if (qbOrder && qbOrder.items && qbOrder.items.length === 0) {
        logger.warn(`[post-edit-sync] ⚠️ Order fetched has no items!`);
      }

      // Dynamic import because of path nesting
      const {
        getSoTxnId,
        getEstimateTxnId,
        getLatestInvoiceTxnId,
      } = require("../../../../../lib/quickbooks/qb-metadata-types");
      const {
        buildQbItems,
      } = require("../../../../../lib/quickbooks/order-flow-core");
      const {
        writePipelineRow,
      } = require("../../../../../lib/quickbooks/qb-pipeline");
      const { getDbPool } = require("../../../../utils/db-pool");

      const soTxnId = getSoTxnId(qbOrder?.metadata);
      const estimateTxnId = getEstimateTxnId(qbOrder?.metadata);
      const invoiceTxnId = getLatestInvoiceTxnId(qbOrder?.metadata);

      // Determine whether the QB invoice is still active (confirmed but not voided).
      // A voided invoice means the SO may be open again — allow the Mod in that case.
      // Two void signals: confirmed void_invoice pipeline row OR pos_invoice.status='voided'.
      // The latter covers voids that happened before QB void-sync was wired up.
      let hasActiveInvoice = false;
      if (invoiceTxnId) {
        const { rows: activeRows } = await getDbPool().query(
          `SELECT id FROM qb_order_pipeline
           WHERE order_id = $1 AND step IN ('invoice', 'sales_receipt') AND status = 'confirmed'
           AND NOT EXISTS (
             SELECT 1 FROM qb_order_pipeline v
             WHERE v.order_id = $1 AND v.step = 'void_invoice' AND v.status = 'confirmed'
           )
           AND NOT EXISTS (
             SELECT 1 FROM pos_invoice pi
             WHERE pi.order_id = $1 AND pi.status = 'voided' AND pi.deleted_at IS NULL
           )
           LIMIT 1`,
          [id]
        );
        hasActiveInvoice = activeRows.length > 0;
      }

      // Check if a QB Sales Order needs to be created after a void.
      // Two signals:
      //   'waiting'  — void route (new path) explicitly bumped the row, SO needs creation
      //   'skipped' + voided pos_invoice — void happened before repair code was deployed;
      //               invoice was never QB-synced so invoiceTxnId is also null
      // Guard: for >= 1h, void route fires SO creation directly (pipeline → 'submitted'),
      // so this stays false — no duplicate risk.
      const { rows: soRepairRows } = await getDbPool().query(
        `SELECT 1 FROM qb_order_pipeline
         WHERE order_id = $1 AND step = 'sales_order'
           AND (
             status = 'waiting'
             OR (
               status = 'skipped'
               AND EXISTS (
                 SELECT 1 FROM pos_invoice pi
                 WHERE pi.order_id = $1 AND pi.status = 'voided' AND pi.deleted_at IS NULL
               )
             )
           )
         LIMIT 1`,
        [id]
      );
      const soNeedsRepair = soRepairRows.length > 0;

      if (
        (soTxnId || estimateTxnId) &&
        !hasActiveInvoice &&
        qbOrder?.items &&
        qbOrder.items.length > 0
      ) {
        const isEstimateOnly = estimateTxnId && !soTxnId;
        const txnId = soTxnId || estimateTxnId;
        const docTypeStr = isEstimateOnly ? "Estimate" : "Sales Order";

        logger.info(
          `[post-edit-sync] QB integration: Pushing ${docTypeStr} modifications to txnId=${txnId}...`
        );

        // Delegate to the shared MOD handler — gold-standard sequential-save
        // pattern: coalesceIfInFlight → writePipelineRow(pending) → withQbSerialized
        // callback (idempotent reset + bridge MOD + writePipelineRow(submitted/failed)
        // + pollUntilQbConfirmed). Prevents duplicate pipeline rows on rapid saves
        // and avoids duplicate bridge calls by coalescing into next_payload.
        try {
          // 1.5.4: pipeline-only — enqueue 'pending' instead of direct handler call.
          // Consolidator picks up next tick and runs the same handlers.
          const {
            writePipelineRow,
          } = require("../../../../../lib/quickbooks/qb-pipeline");
          await writePipelineRow({
            orderId: id,
            step: isEstimateOnly ? "estimate" : "sales_order",
            status: "pending",
            // intent:"mod" — the QB doc already exists (txnId). Without this the
            // QB_CREATE_STEPS guard leaves the confirmed row untouched and the
            // consolidator never runs the MOD, silently dropping the edit
            // (order 2450 SKU swap). MOD is idempotent, so reactivating the row is safe.
            intent: "mod",
            qbTxnId: txnId,
          });
          logger.info(
            `[post-edit-sync] 📥 Enqueued ${isEstimateOnly ? "estimate" : "sales_order"} MOD for ${id} (txnId=${txnId})`
          );
        } catch (modErr: any) {
          logger.error(
            `[post-edit-sync] ❌ Failed to schedule ${docTypeStr} MOD: ${modErr.message}`
          );
        }

        results.qb_sync = "queued_async";
      } else if (hasActiveInvoice) {
        // Active invoice in QB — SO is closed, but the order IS synced via invoice.
        // Clear any stale "error" by reflecting the real QB state.
        logger.info(
          `[post-edit-sync] ⏭️ QB SO/Estimate Mod skipped — active invoice (${invoiceTxnId}) owns the QB document`
        );
        try {
          await getDbPool().query(
            `UPDATE "order" SET metadata = COALESCE(metadata, '{}') || '{"qb_sync_status":"child_synced"}'::jsonb WHERE id = $1`,
            [id]
          );
        } catch (e) {}
        results.qb_sync = "skipped_invoiced";
      } else {
        // No SO/Estimate in QB (order was direct-to-invoice or SO skipped).
        // soNeedsRepair covers orders where the invoice was voided but never QB-synced
        // (invoiceTxnId would be null). The void route sets the pipeline row to 'waiting'
        // as the signal. For >= 1h orders, the void route fires SO creation directly
        // (pipeline goes to 'submitted'), so soNeedsRepair is false — no duplicate risk.
        if (
          (invoiceTxnId || soNeedsRepair) &&
          !hasActiveInvoice &&
          (qbOrder?.items?.length ?? 0) > 0
        ) {
          // Invoice was voided → order is open again with items.
          // Respect the 1-hour window: if the order is < 1h old, skip SO creation —
          // it will go directly to Invoice/Sales Receipt (same guard as qb-pos-sync cron).
          const { rows: orderTimeRows } = await getDbPool().query(
            `SELECT created_at FROM "order" WHERE id = $1`,
            [id]
          );
          const createdAt: Date | undefined = orderTimeRows[0]?.created_at;
          const ageMs = createdAt
            ? Date.now() - new Date(createdAt).getTime()
            : Infinity;
          const ONE_HOUR_MS = 60 * 60 * 1000;

          if (ageMs < ONE_HOUR_MS) {
            logger.info(
              `[post-edit-sync] ⏭️ Order < 1h old — skipping SO creation after void (expect direct Invoice/SR)`
            );
            results.qb_sync = "skipped_too_new";
          } else {
            // → Order is old enough: create a new QB Sales Order.
            // qb_list_id may not be in order metadata if the order was placed before
            // qb_list_id propagation was wired up — fall back to the customer record.
            let qbListId = qbOrder?.metadata?.qb_list_id as string | undefined;
            if (!qbListId) {
              try {
                const custRes = await getDbPool().query(
                  `SELECT c.metadata->>'qb_list_id' AS qb_list_id
                   FROM "order" o JOIN customer c ON c.id = o.customer_id
                   WHERE o.id = $1`,
                  [id]
                );
                const custQbId = custRes.rows[0]?.qb_list_id as
                  | string
                  | null
                  | undefined;
                qbListId = custQbId ?? undefined;
                if (qbListId) {
                  logger.info(
                    `[post-edit-sync] 📋 Using customer qb_list_id=${qbListId} (not in order metadata)`
                  );
                }
              } catch (custErr: any) {
                logger.warn(
                  `[post-edit-sync] Could not fetch customer qb_list_id: ${custErr.message}`
                );
              }
            }
            if (qbListId) {
              // 1.5.12: createSalesOrderInQb removed — enqueue via consolidator.
              const {
                coalesceIfInFlight,
              } = require("../../../../../lib/quickbooks/qb-pipeline");
              const createItems = buildQbItems(
                qbOrder!.items,
                qbOrder!.metadata
              );
              const salesRep = parseSalesRepInitials(
                qbOrder?.metadata?.sales_rep
              );
              const friendlyRef =
                (qbOrder?.metadata?.document_number as string) ||
                (qbOrder?.display_id ? `S${qbOrder.display_id}` : undefined);

              logger.info(
                `[post-edit-sync] 🔄 Voided invoice detected — queuing new QB SO for order ${id}...`
              );

              // Guard against duplicate QB SO creation on rapid post-edit-syncs:
              // if a sales_order op is already submitted/in-flight, coalesce into
              // next_payload and skip the bridge call. The consolidator will
              // re-submit via resubmitByStep after the in-flight op confirms.
              const coalesced = await coalesceIfInFlight(
                id,
                null,
                "sales_order"
              );
              if (coalesced) {
                logger.info(
                  `[post-edit-sync] ⏸ SO CREATE coalesced — in-flight op will pick up latest state after confirm`
                );
                results.qb_sync = "coalesced";
                // continue past this branch
              } else {
                try {
                  await getDbPool().query(
                    `UPDATE "order" SET metadata = COALESCE(metadata, '{}') || '{"qb_sync_status":"pending"}'::jsonb WHERE id = $1`,
                    [id]
                  );
                } catch (mErr) {}

                try {
                  await writePipelineRow({
                    orderId: id,
                    step: "sales_order",
                    status: "pending",
                    medusaRefNumber: friendlyRef,
                  });
                } catch (pErr: any) {}

                withQbSerialized(
                  `sales_order:${id}`,
                  { orderId: id, steps: ["sales_order"] },
                  async () => {
                    try {
                      // 1.5.12: pipeline-only — enqueue 'pending' SO with full
                      // payload. Consolidator's case 'sales_order' (added in
                      // 1.5.5) submits to bridge.
                      await writePipelineRow({
                        orderId: id,
                        step: "sales_order",
                        status: "pending",
                        payload: {
                          customerId: qbListId,
                          date: new Date().toISOString().split("T")[0],
                          items: createItems,
                          ...(salesRep ? { salesRep } : {}),
                        },
                      });
                      logger.info(
                        `[post-edit-sync] 📥 Enqueued sales_order for ${id}`
                      );
                    } catch (e: any) {
                      logger.error(
                        `[post-edit-sync] ❌ enqueue exception: ${e.message}`
                      );
                      try {
                        await getDbPool().query(
                          `UPDATE "order" SET metadata = COALESCE(metadata, '{}') || '{"qb_sync_status":"error"}'::jsonb WHERE id = $1`,
                          [id]
                        );
                        await writePipelineRow({
                          orderId: id,
                          step: "sales_order",
                          status: "failed",
                          error: e.message,
                        });
                      } catch (err) {}
                    }
                  },
                  { logger }
                );

                results.qb_sync = "new_so_queued";
              } // end else (not coalesced)
            } else {
              logger.warn(
                `[post-edit-sync] ⚠️ Voided invoice but no qb_list_id on order — cannot create QB SO`
              );
              results.qb_sync = "no_qb_customer";
            }
          }
        } else {
          results.qb_sync = "no_so_to_update";
        }
      }
    } else if (skipQb) {
      logger.info(
        `[post-edit-sync] ⏭️ Skipping async QB SO Mod (skip_qb=true, no changes)`
      );
      results.qb_sync = "skipped_clean";
    }
  } catch (e: any) {
    logger.warn(
      `[post-edit-sync] QuickBooks document mod sync non-fatal err: ${e.message}`
    );
  }

  // ── Persist POS-computed total BEFORE the reconcile below — pos_total is
  // the source of truth for the reservation clamp ("el POS order define el
  // monto linkeado") and for list-view consistency.
  if (pos_total != null && pos_total > 0) {
    try {
      const pool = getDbPool();
      await pool.query(
        `UPDATE "order" SET metadata = COALESCE(metadata, '{}') || jsonb_build_object('pos_total', $1::numeric) WHERE id = $2`,
        [pos_total, id]
      );
      logger.info(`[post-edit-sync] ✅ Persisted pos_total=$${pos_total} in metadata`);
    } catch (e: any) {
      logger.warn(`[post-edit-sync] Failed to persist pos_total: ${e.message}`);
    }
  }

  // ── Reservation clamp + credit gap ──────────────────────────────────────
  // Order total went DOWN → auto-release the excess order-only reservation
  // back to the payment's available pool. Order total went UP → report the
  // gap so the POS can OFFER covering it with available credit (the
  // Cover-with-Credit modal — never auto-links). Non-fatal.
  try {
    const reconcile = await reconcileOrderReservations(req.scope, id, {
      logger,
    });
    if (reconcile) {
      results.reservation_reconcile = {
        released_cents: reconcile.released_cents,
        gap_cents: reconcile.state.total_unknown ? 0 : reconcile.state.gap_cents,
        allowed_cents: reconcile.state.allowed_cents,
        linked_cents: reconcile.state.order_only_cents,
      };
    }
  } catch (e: any) {
    logger.warn(
      `[post-edit-sync] reservation reconcile non-fatal err: ${e.message}`
    );
  }

  // A refused money write is NOT a success. `results.tax_error` is set when the
  // total could not be derived and `order_summary` was deliberately left alone —
  // but the tax lines above may already have been rewritten, so the order is in
  // a mixed state and the POS must be told. Answering 200 {success:true} here
  // meant the cashier saw the edit land while the stored total stayed stale, and
  // that stale total is the clamp ceiling for order_money_projection.
  if (results.tax_error) {
    res.status(409).json({
      success: false,
      code: "ORDER_TOTAL_NOT_DERIVABLE",
      message:
        "The order total could not be derived, so order_summary was left unchanged. " +
        "The order's tax lines may already reflect the edit — re-save the order to retry.",
      ...results,
    });
    return;
  }

  res.status(200).json({ success: true, ...results });
}
