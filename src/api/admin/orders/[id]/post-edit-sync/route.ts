import type {
  AuthenticatedMedusaRequest,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework";
import { assertOrderEditable } from "../_lib/assert-order-editable";
import { assertWebOrderAuthorized } from "../_lib/assert-web-order-authorized";
import {
  extractWebEditAudit,
  recordWebOrderEditFootprint,
} from "../_lib/web-edit-attestation";
import { ContainerRegistrationKeys } from "@medusajs/utils";
import { syncInventoryItemToMeiliSearchWorkflow } from "../../../../../workflows/sync-inventory-item-meilisearch";

import { parseSalesRepInitials } from "../../../../../lib/quickbooks/parse-sales-rep";
import { withQbSerialized } from "../../../../../lib/quickbooks/qb-serializer";
import { reconcileOrderReservations } from "../../../../../lib/finance/reconcile-order-reservations";
import { getDbPool } from "../../../../utils/db-pool";
import { recordPosActivity } from "../../../../../lib/pos/order-activity";
import type { KnexRawConnection } from "../../../../../lib/pos/order-activity";
import { applyOrderDiscount } from "../../../../../lib/order-discount/apply-order-discount";
import { resolveCposPromotion } from "../../../../../lib/order-discount/resolve-cpos-promotion";

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
    promotion_code,
    pos_discount_amount,
    pos_total,
    pos_tax_amount,
    pos_tax_rate,
    shipping_address,
    billing_address,
  } = req.body as {
    discount_type?: string;
    discount_value?: number; // Raw discount value: percent rate (e.g. 5) OR fixed dollar amount
    promotion_code?: string;
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
  // El PIN de supervisor viaja a los self-calls: `apply-discount-force` está
  // gateado por origen web (assertWebOrderAuthorized), y sin reenviarlo la
  // ruta hija rechazaba el descuento de una orden web mientras este padre
  // seguía de largo hacia la rama de recovery.
  const supervisorPinHeader = String(req.headers["x-supervisor-pin"] ?? "");
  if (supervisorPinHeader) {
    authHeaders["x-supervisor-pin"] = supervisorPinHeader;
  }
  const logger = req.scope.resolve("logger");
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY);
  const results: Record<string, any> = {};

  // ── El descuento del POS se resuelve UNA vez, con semántica de PRESENCIA ──
  //
  // `pos_discount_amount` viene en TODO save del POS, 0 incluido — y 0 significa
  // "sin descuento", no "no sé". El bloque de totales lo trataba como falsy y
  // caía a los adjustments de la DB, que en el save que QUITA un descuento
  // siguen vivos hasta que la reconciliación (más abajo) los borra: la ruta
  // derivaba el total con el descuento fantasma y recién después lo eliminaba
  // (S11432: quedó guardado 26,116.47 sobre una orden de 31,049.51). La
  // reconciliación ya resolvía la presencia bien; ahora AMBOS bloques leen este
  // mismo valor — dos resoluciones distintas de "el descuento" en la misma ruta
  // son la misma clase de bug que los tres campos de total.
  const explicitPosDiscount: number | undefined =
    pos_discount_amount !== undefined && pos_discount_amount !== null
      ? Number(pos_discount_amount)
      : discount_value && discount_value > 0 && discount_type === "fixed"
        ? discount_value
        : undefined;

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

  // ── Apply Hard Wipe of Stale Data ───────────────────────────────────────
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    const pool = getDbPool();
    try {
      // 2. Delete old order_change_action rows (keep only latest order_change)
      const ocaDel = await pool.query(
        `DELETE FROM order_change_action
                 WHERE order_change_id IN (
                     SELECT id FROM order_change WHERE order_id = $1
                     AND change_type IS DISTINCT FROM 'pos_activity'
                     AND id != (SELECT id FROM order_change WHERE order_id = $2
                                AND change_type IS DISTINCT FROM 'pos_activity'
                                ORDER BY created_at DESC LIMIT 1)
                 )`,
        [id, id]
      );
      logger.info(
        `[post-edit-sync] 🧹 Hard-deleted ${ocaDel.rowCount ?? 0} stale order_change_action row(s)`
      );

      // 3. Delete old order_change rows (keep only latest)
      const ocDel = await pool.query(
        `DELETE FROM order_change WHERE order_id = $1
                 AND change_type IS DISTINCT FROM 'pos_activity'
                 AND id != (SELECT id FROM order_change WHERE order_id = $2
                            AND change_type IS DISTINCT FROM 'pos_activity'
                            ORDER BY created_at DESC LIMIT 1)`,
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

  // ── Descuento + tax + totales canónicos: EL chokepoint, en UNA transacción ──
  //
  // `applyOrderDiscount` (lib/order-discount) es el ÚNICO escritor del
  // descuento de una orden confirmada: adjustments + link + metadata + tax
  // lines + summary + los tres totales + payment_collection, todo o nada,
  // con advisory lock por orden. Reemplaza a las tres ramas de reconciliación
  // que vivían acá, al self-call a apply-discount-force y a
  // applyTaxAndCanonicalTotals — derivar y reconciliar por separado es lo que
  // envenenó a S11432; acá ya no existe el "entre".
  if (explicitPosDiscount !== undefined || pos_tax_amount != null) {
    if (pos_tax_amount == null) {
      // Declarar el descuento SIN el tax es la mitad del dinero — la clase de
      // ambigüedad que este dominio ya pagó dos veces (S11432, E2146).
      res.status(400).json({
        message:
          "post-edit-sync: declarar descuento requiere también pos_tax_amount (0 explícito es válido)",
      });
      return;
    }
    // Tres modos: intent (aplicar) · null (quitar, 0 explícito) · undefined
    // (caller legacy sin declaración → derive-only, los adjustments quedan).
    // Un declarado > 0 sin type/value se canoniza como fixed por el monto.
    const intent =
      explicitPosDiscount === undefined
        ? undefined
        : explicitPosDiscount > 0
          ? discount_type && discount_value && discount_value > 0
            ? ({
                type: discount_type === "percent" ? "percent" : "fixed",
                value: Number(discount_value),
              } as const)
            : ({ type: "fixed", value: explicitPosDiscount } as const)
          : null;
    try {
      const promo = intent
        ? await resolveCposPromotion(req.scope, intent, {
            preferredCode: promotion_code || null,
          })
        : null;
      const applied = await applyOrderDiscount(getDbPool(), id, {
        intent,
        declaredDiscountDollars: explicitPosDiscount,
        tax: { ratePercent: pos_tax_rate ?? 7, posTaxAmount: pos_tax_amount },
        promo,
        logger,
      });
      results.discount = applied.discountDollars;
      results.tax_injected = applied.taxDollars;
      results.computed_total = applied.totalDollars;
      results.payment_fixed = applied.totalDollars;
    } catch (e: any) {
      // Fallo monetario ABORTA la ruta: seguir hacia la sección QB con un
      // total no derivado es publicar el estado que el chokepoint impide.
      logger.error(
        `[post-edit-sync] ❌ chokepoint de descuento falló: ${e.message}`
      );
      res
        .status(500)
        .json({ message: `order money not derivable: ${e.message}` });
      return;
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
        getBusinessDateString,
      } = require("../../../../../lib/date/et");
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
            medusaRefNumber:
              (qbOrder?.metadata?.document_number as string) ||
              (qbOrder?.display_id
                ? `${isEstimateOnly ? "E" : "S"}${qbOrder.display_id}`
                : null),
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
                          date: getBusinessDateString(),
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
  //
  // Sólo corre cuando la derivación de arriba NO escribió. Si escribió, sus
  // tres campos ya están alineados entre sí y pisar `pos_total` con la cifra
  // del navegador volvería a dejar dos números distintos para la misma orden.
  if (
    results.computed_total == null &&
    pos_total != null &&
    pos_total > 0
  ) {
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

  // Native Activity Log footprint — one save = one entry. This route runs on
  // every order save AND on Force re-sync — both count as an edit.
  const actorId =
    (req as AuthenticatedMedusaRequest).auth_context?.actor_id ?? null;
  const knexConn = req.scope.resolve("__pg_connection__") as KnexRawConnection;
  await recordPosActivity(knexConn, {
    orderId: id,
    event: "order_edited",
    details: { docType: "Order" },
    userId: actorId,
  });

  // Huella de edición de orden web (no-op para órdenes POS): sellada
  // DESPUÉS del efecto, deduplicada por operation_id entre las rutas de un
  // mismo Save. post-edit-sync es la última ruta del flujo de guardado.
  await recordWebOrderEditFootprint(
    req.scope,
    id,
    "post-edit-sync",
    extractWebEditAudit(req)
  );

  res.status(200).json({ success: true, ...results });
}
