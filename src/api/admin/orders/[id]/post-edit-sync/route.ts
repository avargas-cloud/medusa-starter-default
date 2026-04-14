import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/utils";
import { getDbPool } from "../../../../utils/db-pool";
import { parseSalesRepInitials } from "../../../../../lib/quickbooks/parse-sales-rep";
import { withQbSerialized } from "../../../../../lib/quickbooks/qb-serializer";

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
        let calculatedTax = 0;
        try {
          const { data } = await query.graph({
            entity: "order",
            fields: ["tax_total"],
            filters: { id },
          });
          calculatedTax = Number(data?.[0]?.tax_total ?? 0);
        } catch {
          /* non-fatal */
        }

        // 2. Fetch item IDs for tax line operations.
        const itemsRes = await pool.query<{ item_id: string }>(
          `SELECT DISTINCT oi.item_id FROM order_item oi WHERE oi.order_id = $1 AND oi.deleted_at IS NULL`,
          [id]
        );
        const itemIds = itemsRes.rows.map((r) => r.item_id);

        // Use the statutory tax rate (7% FL). Do NOT back-calculate from gross subtotal.
        // With pos-tax provider fixed (provider_id='tp_pos-tax') and adjustments loaded:
        // 7% × (subtotal − discount) = correct amount ✅
        // This fallback only runs if apply-discount-force tax insertion missed something.
        const effectiveRate = pos_tax_rate ?? 7;

        logger.info(
          `[post-edit-sync] CALCULATED TAX = $${calculatedTax.toFixed(2)} | POS TAX = $${pos_tax_amount.toFixed(2)}`
        );
        if (Math.abs(calculatedTax - pos_tax_amount) > 0.005) {
          logger.warn(
            `[post-edit-sync] ⚠️  TAX OVERWRITE: Medusa=$${calculatedTax.toFixed(2)} → POS=$${pos_tax_amount.toFixed(2)} (rate=${effectiveRate}%)`
          );
        }

        if (itemIds.length > 0) {
          // Delete ALL existing tax lines to ensure clean state.
          await pool.query(
            `DELETE FROM order_line_item_tax_line WHERE item_id = ANY($1)`,
            [itemIds]
          );

          const rawRate = JSON.stringify({
            value: String(effectiveRate),
            precision: 20,
          });
          const genId = (prefix: string) =>
            `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

          // Use EXEMPT code when rate is 0, FL when rate is 7
          const taxCode = effectiveRate === 0 ? "EXEMPT" : "FL";
          const taxDesc =
            effectiveRate === 0 ? "Tax Exempt" : "Florida Sales Tax";

          for (const itemId of itemIds) {
            const lineId = genId("taxline");
            await pool.query(
              `INSERT INTO order_line_item_tax_line (id, item_id, code, rate, raw_rate, description, created_at, updated_at)
                             VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
              [lineId, itemId, taxCode, effectiveRate, rawRate, taxDesc]
            );
          }
          logger.info(
            `[post-edit-sync] ✅ Inserted ${taxCode} tax lines at ${effectiveRate}% for ${itemIds.length} items ($${pos_tax_amount} total)`
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

          const newAccountingTotal =
            Number(totals.original_order_total || 0) +
            pos_tax_amount -
            forcedDiscount;

          await pool.query(
            `UPDATE order_summary SET totals = $1, updated_at = NOW() WHERE id = $2`,
            [
              JSON.stringify({
                ...totals,
                tax_total: pos_tax_amount,
                raw_tax_total: { value: String(pos_tax_amount), precision: 20 },
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
      // 1. Delete soft-deleted adjustments
      const adjDel = await pool.query(
        `DELETE FROM order_line_item_adjustment
                 WHERE deleted_at IS NOT NULL
                   AND item_id IN (SELECT DISTINCT item_id FROM order_item WHERE order_id = $1)`,
        [id]
      );
      logger.info(
        `[post-edit-sync] 🧹 Hard-deleted ${adjDel.rowCount ?? 0} stale adjustment row(s)`
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
      const recheckRes = await fetch(
        `${base}/admin/orders/${id}?fields=discount_total`,
        { headers: authHeaders }
      );
      if (recheckRes.ok) {
        const { order: recheckOrder } = await recheckRes.json();
        const medusaDiscount = Number(recheckOrder?.discount_total ?? 0);
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
        const {
          updateInventoryIncrementalWorkflow,
        } = require("../../../../../workflows/update-inventory-incremental");
        for (const variantId of variantIds) {
          await updateInventoryIncrementalWorkflow(req.scope).run({
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
    const skipQb = (req.body as any).skip_qb === true;
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
      } = require("../../../../../lib/quickbooks/qb-metadata-types");
      const {
        updateSalesOrderInQb,
      } = require("../../../../../lib/quickbooks/client/sales-orders");
      const {
        updateEstimateInQb,
      } = require("../../../../../lib/quickbooks/client/estimates");
      const {
        buildQbItems,
      } = require("../../../../../lib/quickbooks/order-flow-core");
      const {
        writePipelineRow,
      } = require("../../../../../lib/quickbooks/qb-pipeline");
      const { getDbPool } = require("../../../../utils/db-pool");

      const soTxnId = getSoTxnId(qbOrder?.metadata);
      const estimateTxnId = getEstimateTxnId(qbOrder?.metadata);

      if (
        (soTxnId || estimateTxnId) &&
        qbOrder?.items &&
        qbOrder.items.length > 0
      ) {
        const isEstimateOnly = estimateTxnId && !soTxnId;
        const txnId = soTxnId || estimateTxnId;
        const docTypeStr = isEstimateOnly ? "Estimate" : "Sales Order";
        const pipelineStep = isEstimateOnly ? "estimate" : "sales_order";

        logger.info(
          `[post-edit-sync] QB integration: Pushing ${docTypeStr} modifications to txnId=${txnId}...`
        );
        const modItems = buildQbItems(qbOrder.items, qbOrder.metadata);

        // Inject pre-flight metadata so UI shows "PENDING"
        const friendlyRef =
          (qbOrder.metadata?.document_number as string) ||
          (qbOrder.display_id
            ? isEstimateOnly
              ? `E${qbOrder.display_id}`
              : `S${qbOrder.display_id}`
            : null);

        try {
          const pool = getDbPool();
          await pool.query(
            `UPDATE "order" SET metadata = COALESCE(metadata, '{}') || $1::jsonb WHERE id = $2`,
            [JSON.stringify({ qb_sync_status: "pending" }), id]
          );
        } catch (mErr) {
          logger.warn(`[post-edit-sync] Could not set pending status: ${mErr}`);
        }

        // Write "pending" pipeline row immediately
        try {
          await writePipelineRow({
            orderId: id,
            step: pipelineStep,
            status: "pending",
            medusaRefNumber: friendlyRef,
          });
        } catch (pErr: any) {
          logger.warn(
            `[post-edit-sync] ⚠️ Could not write pre-flight pipeline row: ${pErr.message}`
          );
        }

        // Serialized per order — prevents EditSequence conflicts on rapid saves
        const salesRep = parseSalesRepInitials(qbOrder?.metadata?.sales_rep);
        const updateFn = isEstimateOnly
          ? updateEstimateInQb
          : updateSalesOrderInQb;
        withQbSerialized(
          `${pipelineStep}:${id}`,
          { orderId: id, steps: [pipelineStep] },
          async () => {
            try {
              const qbRes = await updateFn({
                txnId,
                items: modItems,
                ...(salesRep ? { salesRep } : {}),
              });
              if (qbRes.success) {
                logger.info(
                  `[post-edit-sync] ✅ Async QB ${docTypeStr} queue successful! opId=${qbRes.data?.operationId}`
                );
                try {
                  await writePipelineRow({
                    orderId: id,
                    step: pipelineStep,
                    status: "submitted",
                    bridgeOpId: qbRes.data?.operationId,
                    qbTxnId: txnId,
                  });
                } catch (e: any) {
                  logger.warn(
                    `[post-edit-sync] Could not update pipeline row on success: ${e.message}`
                  );
                }
              } else {
                logger.error(
                  `[post-edit-sync] ❌ Async QB ${docTypeStr} Mod failed: ${qbRes.error}`
                );
                try {
                  const pool = getDbPool();
                  await pool.query(
                    `UPDATE "order" SET metadata = COALESCE(metadata, '{}') || '{"qb_sync_status": "error"}'::jsonb WHERE id = $1`,
                    [id]
                  );
                  await writePipelineRow({
                    orderId: id,
                    step: pipelineStep,
                    status: "failed",
                    error: qbRes.error,
                    qbTxnId: txnId,
                  });
                } catch (e) {}
              }
            } catch (e: any) {
              logger.error(
                `[post-edit-sync] ❌ Async QB ${docTypeStr} Mod Exception: ${e.message}`
              );
              try {
                const pool = getDbPool();
                await pool.query(
                  `UPDATE "order" SET metadata = COALESCE(metadata, '{}') || '{"qb_sync_status": "error"}'::jsonb WHERE id = $1`,
                  [id]
                );
                await writePipelineRow({
                  orderId: id,
                  step: pipelineStep,
                  status: "failed",
                  error: e.message,
                  qbTxnId: txnId,
                });
              } catch (err) {}
            }
          },
          { logger }
        );

        results.qb_sync = "queued_async";
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

  res.status(200).json({ success: true, ...results });
}
