import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import {
  ContainerRegistrationKeys,
  Modules,
  OrderStatus,
  OrderWorkflowEvents,
} from "@medusajs/utils";

import { getDbPool } from "../../../../utils/db-pool";
import { FINANCE_MODULE } from "../../../../../modules/finance";
import { buildOrderCostSnapshot } from "../../../../../lib/finance/build-order-cost-snapshot";
import { upsertOrderOnlyApplication } from "../../../../../lib/finance/upsert-order-only-application";
import { USA_LOC } from "../../../../../lib/locations";
import { listActiveReservationsRaw } from "../../../../../lib/reservations";
import {
  replaceOrderTaxLines,
  representedDiscountDollars,
  resolvePatchedOrderTotal,
  loadOrderMoneyBase,
  resolveQbParityTax,
} from "../../../../../lib/order-money/order-tax-lines";

/**
 * POST /admin/draft-orders/:id/convert-force
 *
 * Converts a draft order to a confirmed order with two key guarantees:
 *
 * 1. BACKORDER SUPPORT: Items with 0 stock are accepted. If Medusa's native
 *    conversion fails due to insufficient inventory, we temporarily enable
 *    allow_backorder on the affected inventory items, retry, then restore.
 *
 * 2. TAX FIDELITY: After conversion, Medusa may re-run its own tax calculation
 *    (e.g., FL Tax Region at 7%) on top of our custom tax_lines, causing the
 *    payment collection amount to be inflated (double-counted tax).
 *    We fix this by reading the `current_order_total` that our compute-tax
 *    already stored in order_summary, then patching the payment collection
 *    to use that exact value—preserving the exact tax decision made in the
 *    draft (including 0% for tax-exempt customers, non-FL addresses, etc).
 */
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const { id } = req.params as { id: string };
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY);

  const base = `http://localhost:${process.env.PORT ?? 9000}`;
  const authHeaders: Record<string, string> = {
    Cookie: String(req.headers["cookie"] ?? ""),
    Authorization: String(req.headers["authorization"] ?? ""),
    "Content-Type": "application/json",
  };

  // ── Helper: compute the true order total ──────────────────────────────────
  // PRIORITY 1: metadata.computed_total — saved by compute-tax using correctly-rounded
  //             discount logic (Math.round per component), avoiding Medusa's fractional
  //             accumulation that can cause 1 cent errors (e.g. $84.28 instead of $84.27).
  // PRIORITY 2: Explicit math recalculation (Subtotal - Discount + Tax) using Medusa's API fields.
  const computeTrueTotal = async (): Promise<number | null> => {
    try {
      const { data } = await query.graph({
        entity: "order",
        fields: [
          "total",
          "tax_total",
          "subtotal",
          "discount_total",
          "metadata",
        ],
        filters: { id },
      });
      const order = data?.[0];
      if (!order) return null;

      // Prefer our correctly-rounded computed_total from metadata
      const computedMeta = order.metadata?.computed_total;
      if (computedMeta && Number(computedMeta) > 0) {
        console.log(
          `[convert-force] Using metadata.computed_total: ${computedMeta} (Medusa order.total: ${order.total})`
        );
        return Number(computedMeta);
      }

      // El fallback manual `subtotal − discount + tax` se RETIRÓ
      // (descuentos-canonicos-v1): era la misma familia de derivación paralela
      // que envenenó S11432 y sólo corría cuando faltaba computed_total. Sin
      // computed_total este helper devuelve null, los fixes intermedios se
      // saltean, y la derivación canónica del final —que ahora es FAIL-CLOSED—
      // escribe summary + los tres campos + payment collection desde las
      // líneas reales.
      console.log(
        `[convert-force] metadata.computed_total ausente — la derivación canónica del cierre resolverá (Medusa order.total: ${order.total})`
      );
      return null;
    } catch (e: any) {
      console.warn(
        "[convert-force] Could not calculate true total:",
        e?.message
      );
      return null;
    }
  };

  // ── Helper: patch payment collection to the correct amount ────────────────
  const fixPaymentCollection = async (correctTotal: number) => {
    try {
      const db = getDbPool();
      const client = await db.connect();
      try {
        // Find payment collections linked to this order
        const res = await client.query(
          `SELECT opc.payment_collection_id 
                     FROM order_payment_collection opc 
                     WHERE opc.order_id = $1`,
          [id]
        );

        const pcolIds = res.rows.map((r) => r.payment_collection_id);
        if (pcolIds.length === 0) return;

        const correctAmount = correctTotal;

        for (const pcId of pcolIds) {
          const pcRes = await client.query(
            `SELECT amount FROM payment_collection WHERE id = $1`,
            [pcId]
          );
          if (pcRes.rows[0] && Number(pcRes.rows[0].amount) !== correctAmount) {
            console.log(
              `[convert-force] Patching Payment Collection ${pcId} via SQL: ${pcRes.rows[0].amount} → ${correctAmount}`
            );
            await client.query(
              `UPDATE payment_collection SET amount = $1, updated_at = NOW() WHERE id = $2`,
              [correctAmount, pcId]
            );
          }
        }
      } finally {
        client.release();
      }
    } catch (e: any) {
      console.warn(
        "[convert-force] Could not SQL patch payment collection:",
        e?.message
      );
    }
  };

  try {
    // ── Idempotent duplicate guard ────────────────────────────────────────────
    // A double-submit creates two drafts that BOTH reach convert-force; each
    // consumes a gapless S-number and becomes a duplicate confirmed order
    // (S10617/S10618 etc). The frontend re-entry ref-guard stops the concurrent
    // double-click; this covers network retries / multi-tab where the 2nd request
    // arrives AFTER the 1st committed. If an identical confirmed order (same
    // customer + same line fingerprint) was created in the last 45s, return THAT
    // existing order instead of converting this draft into a second one.
    try {
      const dedupPool = getDbPool();
      const dupRes = await dedupPool.query(
        `WITH draft AS (
           SELECT o.customer_id,
                  string_agg(COALESCE(oli.variant_id, oli.title) || ':' || oi.quantity::text, ','
                             ORDER BY COALESCE(oli.variant_id, oli.title), oi.quantity::text) AS fp
             FROM "order" o
             JOIN order_item oi ON oi.order_id = o.id AND oi.version = o.version
             JOIN order_line_item oli ON oli.id = oi.item_id
            WHERE o.id = $1
            GROUP BY o.customer_id
         ),
         cand AS (
           SELECT o.id, o.display_id, o.metadata->>'document_number' AS docnum, o.created_at,
                  string_agg(COALESCE(oli.variant_id, oli.title) || ':' || oi.quantity::text, ','
                             ORDER BY COALESCE(oli.variant_id, oli.title), oi.quantity::text) AS fp
             FROM "order" o
             JOIN order_item oi ON oi.order_id = o.id AND oi.version = o.version
             JOIN order_line_item oli ON oli.id = oi.item_id
            WHERE o.is_draft_order = false
              AND o.id <> $1
              AND o.deleted_at IS NULL
              AND o.created_at > NOW() - INTERVAL '45 seconds'
              AND o.customer_id IS NOT DISTINCT FROM (SELECT customer_id FROM draft)
            GROUP BY o.id
         )
         SELECT cand.id, cand.display_id, cand.docnum
           FROM cand JOIN draft ON cand.fp = draft.fp
          ORDER BY cand.created_at DESC
          LIMIT 1`,
        [id]
      );
      const dup = dupRes.rows[0];
      if (dup) {
        console.warn(
          `[convert-force] ⚠️ Duplicate convert blocked for draft ${id} — returning existing order ${dup.docnum} (${dup.id})`
        );
        return void res.status(200).json({
          order: {
            id: dup.id,
            display_id: dup.display_id,
            metadata: { document_number: dup.docnum },
          },
          deduplicated: true,
        });
      }
    } catch (dedupErr: any) {
      // Non-fatal — never block a real conversion because the guard query failed.
      console.warn(
        `[convert-force] dedup check failed (non-fatal): ${dedupErr?.message}`
      );
    }

    // ── Step 1 & 2: Fetch draft order items and stock location concurrently ───────────
    const [{ data: orderData }, { data: locationData }] = await Promise.all([
      query.graph({
        entity: "order",
        fields: ["items.*", "items.variant_id", "items.variant.id"],
        filters: { id },
      }),
      query.graph({
        entity: "stock_location",
        fields: ["id"],
      }),
    ]);
    const draft_order = orderData?.[0];
    // EXPLICIT Miami — never "first row" (with Miami + China Warehouse both
    // live, [0] could create the apartado in China). Fail closed.
    const primaryLocationId: string | undefined = (
      locationData as { id: string }[] | undefined
    )?.find((loc) => loc.id === USA_LOC)?.id;
    if (!primaryLocationId) {
      console.warn(
        `[convert-force] Miami location ${USA_LOC} not found — skipping reservation creation`
      );
    }

    if (draft_order) {
      const items: any[] = draft_order?.items ?? draft_order?.cart?.items ?? [];

      if (primaryLocationId && items.length > 0) {
        // ── Step 3: Ensure allow_backorder reservations for all items ─
        // Creating reservations before conversion means convert-to-order
        // finds existing reservations and skips the stock check entirely.
        const { createReservationsWorkflow } = require("@medusajs/core-flows");

        for (const lineItem of items) {
          const lineItemId: string = lineItem.id;
          const variantId: string | undefined =
            lineItem.variant_id ?? lineItem.variant?.id;
          if (!variantId) continue;

          // Skip if reservation already exists. Raw SQL — the module's
          // { line_item_id } filter is unreliable in Medusa v2 and a
          // false-negative here would mint a DUPLICATE reservation.
          try {
            const knex = req.scope.resolve("__pg_connection__") as any;
            const existingRes = await listActiveReservationsRaw(
              knex,
              lineItemId
            );
            if (existingRes.length > 0) continue;
          } catch (e) {
            /* ignore */
          }

          // Find the inventory item for this variant
          const { data: variants } = await query.graph({
            entity: "variant",
            fields: ["id", "inventory_items.inventory_item_id"],
            filters: { id: variantId },
          });
          const inventoryItemId =
            variants[0]?.inventory_items?.[0]?.inventory_item_id;
          if (!inventoryItemId) {
            console.warn(
              `[convert-force] No inventory item for variant ${variantId}, skipping reservation`
            );
            continue;
          }

          // Create reservation natively with allow_backorder — bypasses stock check
          try {
            await createReservationsWorkflow(req.scope).run({
              input: {
                reservations: [
                  {
                    line_item_id: lineItemId,
                    inventory_item_id: inventoryItemId,
                    location_id: primaryLocationId,
                    quantity: lineItem.quantity ?? 1,
                    allow_backorder: true,
                  },
                ],
              },
            });
            console.log(
              `[convert-force] ✅ Reservation created for lineItem ${lineItemId} (allow_backorder)`
            );
          } catch (resErr: any) {
            console.warn(
              `[convert-force] Reservation failed natively for ${lineItemId}:`,
              resErr?.message
            );
          }
        }
      }
    } else {
      console.warn(
        `[convert-force] Could not fetch draft order ${id} — proceeding without reservation pre-creation`
      );
    }

    // ── Step 4: Convert draft → confirmed order natively (bypassing stock reservation block) ────────
    let convertedOrder;
    try {
      const orderService = req.scope.resolve(Modules.ORDER);

      // Generate the gapless Sales Order (S) sequence synchronously for instant UI resolution
      const pgConnection = req.scope.resolve("__pg_connection__") as any;
      const result = await pgConnection.raw(
        `SELECT nextval('custom_order_seq') AS seq`
      );
      const nextOrdNum = result.rows[0].seq || result.rows[0].SEQ;
      const documentNumber = `S${nextOrdNum}`;

      const meta = (draft_order?.metadata || {}) as Record<string, any>;
      const oldEstimateNumber =
        meta.document_number && meta.document_number.startsWith("E")
          ? meta.document_number
          : null;

      const response = await orderService.updateOrders([
        {
          id,
          status: OrderStatus.PENDING,
          is_draft_order: false,
          metadata: {
            ...meta,
            document_number: documentNumber,
            ...(oldEstimateNumber
              ? { original_estimate_number: oldEstimateNumber }
              : {}),
          },
        },
      ]);
      convertedOrder = response[0];
      console.log(
        `[convert-force] ✅ Assigned ${documentNumber} to newly converted Order ${id}`
      );

      // Write SO waiting pipeline row directly — reliable, bypasses BullMQ outbox.
      // The BullMQ event below may also fire the handler, but writePipelineRow upserts
      // the waiting row so no duplicate is created.
      if (process.env.QB_ORDER_FLOW_ENABLED === "true") {
        try {
          const {
            writePipelineRow,
          } = require("../../../../../lib/quickbooks/qb-pipeline");
          const { getDbPool } = require("../../../../../api/utils/db-pool");
          // Skip the estimate waiting row — it's superseded by the Sales Order
          const pool = getDbPool();
          await pool.query(
            `UPDATE qb_order_pipeline
                         SET status = 'skipped',
                             error  = 'Converted to Sales Order — Estimate not needed'
                         WHERE order_id = $1
                           AND step     = 'estimate'
                           AND status IN ('waiting', 'pending')`,
            [id]
          );
          await writePipelineRow({
            orderId: id,
            step: "sales_order",
            status: "waiting",
            medusaRefNumber: documentNumber,
          });
          console.log(
            `[convert-force] ✅ Skipped estimate row and wrote SO waiting pipeline row for ${documentNumber}`
          );
        } catch (pErr: any) {
          console.warn(
            `[convert-force] ⚠️ Could not write SO pipeline row: ${pErr.message}`
          );
        }
      }

      // Emit the PLACED event purely natively so subscribers like QBDraftOrderSync react properly.
      if (convertedOrder) {
        const eventBus = req.scope.resolve(Modules.EVENT_BUS);
        await eventBus.emit({
          name: OrderWorkflowEvents.PLACED,
          data: { id: convertedOrder.id },
        });
      }
    } catch (cvErr: any) {
      console.error(
        `[convert-force] Direct API Conversion failed:`,
        cvErr?.message
      );
      return void res
        .status(500)
        .json({ message: cvErr?.message ?? "Conversion failed natively" });
    }

    // The conversion above is unconditional and definitive (the catch above
    // already returned on failure) — unlike the tax-injection block further
    // down, this always runs. `order_status` has precedence over the legacy
    // `estimate_status` in every reader, so only that key needs setting.
    try {
      const statusPool = getDbPool();
      await statusPool.query(
        `UPDATE "order"
            SET metadata = COALESCE(metadata, '{}') || jsonb_build_object('order_status', 'Approved')
          WHERE id = $1
            AND COALESCE(metadata->>'order_status', metadata->>'estimate_status', '') <> 'Voided'`,
        [id]
      );
      console.log(`[convert-force] order_status → Approved`);
    } catch (statusErr: any) {
      console.warn(
        `[convert-force] ⚠️ Could not set order_status to Approved: ${statusErr?.message}`
      );
    }

    // ── Step 4b: Link deposits captured against this (now-real) order ─────
    // Deposits taken while this was an Estimate (draft) could NOT create a
    // PaymentApplication at capture time — handle-order-apply rejects draft
    // orders, so the link was deferred (frontend leaves only locked_order_id).
    // The order id is unchanged by conversion, so we can now create the real
    // order-only application (invoice_id = NULL) and freeze the cost basis,
    // making the deposit visible to Treasury without drifting. Idempotent:
    // skips deposits already fully linked. No QB enqueue (order-only).
    try {
      const financeService = req.scope.resolve(FINANCE_MODULE);
      // Find deferred deposits by locked_order_id OR metadata.order_id. The BAMS
      // webhook stamps both (order_id in metadata always; locked_order_id only
      // if finance/payments persisted it) — matching either is belt-and-
      // suspenders so a null locked_order_id (historical gap) never strands a
      // deposit. This was why PAY-3152 was never linked at conversion.
      const depConn = req.scope.resolve("__pg_connection__") as {
        raw: (sql: string, b?: unknown[]) => Promise<{ rows: { id: string }[] }>;
      };
      const idRes = await depConn.raw(
        `SELECT id FROM customer_payment
         WHERE type = 'payment' AND deleted_at IS NULL AND status <> 'voided'
           AND (locked_order_id = ? OR metadata->>'order_id' = ?)`,
        [id, id]
      );
      const depIds = (idRes.rows ?? []).map((r) => r.id);
      const deposits = depIds.length
        ? await financeService.listCustomerPayments(
            { id: depIds } as any,
            { relations: ["applications"] }
          )
        : [];
      const active = (deposits ?? []).filter(
        (d: any) => d.status !== "voided"
      );
      if (active.length > 0) {
        const pgConn = req.scope.resolve("__pg_connection__") as Parameters<
          typeof buildOrderCostSnapshot
        >[0];
        const costSnapshot = await buildOrderCostSnapshot(pgConn, id);
        for (const dep of active) {
          const applied = (dep.applications ?? [])
            .filter((a: any) => !a.voided_at)
            .reduce((s: number, a: any) => s + Number(a.amount_applied), 0);
          const remaining = Number(dep.amount) - applied;
          if (remaining > 0) {
            // UPSERT (constraint-safe): if an active order-only row already
            // exists for (dep, order) — e.g. a manual link landed between a
            // half-failed conversion attempt and this retry — merge into it
            // instead of inserting a duplicate that the partial unique index
            // UQ_payment_application_order_only_active would reject.
            const upserted = await upsertOrderOnlyApplication({
              financeService,
              knex: req.scope.resolve("__pg_connection__"),
              payment_id: dep.id,
              order_id: id,
              amount_cents: remaining,
              applied_by: "system:convert-link",
              cost_snapshot: costSnapshot,
            });
            console.log(
              `[convert-force] ✅ Linked deposit ${dep.id} (${remaining}c, ${upserted.mode}) to converted order ${id}`
            );
          }
        }
      }
    } catch (linkErr: any) {
      console.warn(
        `[convert-force] ⚠️ Deposit-link soft-failed: ${linkErr?.message}`
      );
    }

    // ── Step 5: Fix payment collection total (post-conversion) ───────────
    const correctTotal = await computeTrueTotal();
    if (correctTotal !== null) {
      await fixPaymentCollection(correctTotal);
    }

    // ── Step 6: Remove duplicate tax lines (defensive) ────────────────────
    // Deletes any 'manual' or other non-POS-generated tax lines that may
    // have been added by Medusa's engine before or during conversion.
    // Note: order_line_item_tax_line has no 'amount' column — amounts are
    // computed dynamically. The tax-fix-subscriber also handles this
    // asynchronously after order.placed fires.
    try {
      const db = getDbPool();
      const client = await db.connect();
      try {
        const del = await client.query(
          `DELETE FROM order_line_item_tax_line
                     WHERE item_id IN (SELECT item_id FROM order_item WHERE order_id = $1)
                     AND code NOT IN ('FL', 'FL-SHIPPING', 'EXEMPT')`,
          [id]
        );
        if (del.rowCount && del.rowCount > 0) {
          console.log(
            `[convert-force] ✅ Removed ${del.rowCount} duplicate tax lines post-conversion`
          );
        }
      } finally {
        client.release();
      }
    } catch (taxFixErr: any) {
      console.warn(
        `[convert-force] ⚠️ Post-conversion tax fix soft-failed: ${taxFixErr?.message}`
      );
    }

    // ── Step 7: Inject tax lines using pos-tax provider logic ─────────────
    // Primary source: order.metadata.tax_mode ('exempt' | 'florida' | 'auto')
    // set by the POS tax dropdown. Fallback: customer "tax-exempt" group.
    try {
      // 7a. Read order metadata and customer info
      let isExempt = false;
      try {
        const { data } = await query.graph({
          entity: "order",
          fields: ["customer_id", "metadata"],
          filters: { id },
        });
        const orderInfo = data?.[0];
        if (orderInfo) {
          const taxMode = String(orderInfo?.metadata?.tax_mode ?? "auto");
          console.log(`[convert-force] order.metadata.tax_mode = "${taxMode}"`);

          if (taxMode === "exempt") {
            // Explicitly set to exempt in POS dropdown
            isExempt = true;
            console.log("[convert-force] tax_mode=exempt → EXEMPT");
          } else if (taxMode === "florida") {
            // Explicitly set to FL → force FL regardless of customer group
            isExempt = false;
            console.log("[convert-force] tax_mode=florida → FL 7%");
          } else {
            // 'auto' or missing → check customer group (mirrors pos-tax service.ts)
            if (orderInfo?.customer_id) {
              const { data: custData } = await query.graph({
                entity: "customer",
                fields: ["groups.*"],
                filters: { id: orderInfo.customer_id },
              });
              const customerGroups = custData?.[0]?.groups ?? [];
              isExempt = customerGroups.some(
                (g: any) =>
                  g === "tax-exempt" ||
                  g.name === "tax-exempt" ||
                  (typeof g === "object" &&
                    g.name?.toLowerCase().includes("exempt"))
              );
              if (isExempt)
                console.log(
                  "[convert-force] Customer in tax-exempt group → EXEMPT"
                );
              else console.log("[convert-force] No exempt group → FL 7%");
            }
          }
        }
      } catch {
        /* non-fatal, fall through to FL */
      }

      // 7b. Tax parameters (mirrors pos-tax service.ts identifier constants)
      const taxRate = isExempt ? 0 : 7;
      // The per-line code and description now come from replaceOrderTaxLines,
      // which decides them line by line; this one is only for the log below.
      const taxCode = isExempt ? "EXEMPT" : "FL";
      console.log(`[convert-force] Tax decision: ${taxCode} @ ${taxRate}%`);

      // 7c. Insert tax lines via SQL
      const db = getDbPool();
      const client = await db.connect();
      try {
        // Rewrite the tax lines PER LINE. This loop used to insert one line at
        // `taxRate` for every item with no `taxable` check, taxing exempt lines.
        // Pass the POOL, not the checked-out client. This route calls
        // db.connect() but never issues BEGIN, so handing over the client told
        // the helper "the caller owns a transaction" when nobody did, and the
        // DELETE and INSERT auto-committed separately — the exact partial state
        // the helper exists to prevent. With the pool it opens and owns its own
        // transaction.
        const taxRewrite = await replaceOrderTaxLines(db, id, taxRate);
        const itemIds = taxRewrite.itemIds;

        if (itemIds.length > 0) {
          console.log(
            `[convert-force] ✅ Tax lines rewritten: ${taxRewrite.taxedItemIds.length} taxed @ ${taxRate}%, ` +
              `${taxRewrite.exemptItemIds.length} exempt (${taxCode})`
          );

          // 7d. Derive the tax from the order's own lines — do NOT re-read it
          //     over HTTP.
          //
          //     That fetch ran while THIS transaction was still open, so it went
          //     out on a different connection and could not see the tax lines
          //     the rewrite above had just written. It read the pre-rewrite
          //     state and handed back 0, and the summary was then patched with
          //     a tax_total of zero on an order full of taxable lines — which
          //     also sends the QuickBooks header as Exempt.
          //
          //     Reading through the same client keeps it inside the transaction
          //     and removes the round-trip entirely.
          // El descuento sale de la MISMA base que el resto de la derivación.
          //
          // Antes se leía `order_summary.totals.discount_total`, que es el
          // agregado de Medusa sobre estos mismos adjustments: no puede aportar
          // información que la base no tenga (medido: NULL en 1615 de 1616
          // órdenes, y en la única poblada vale lo mismo que las líneas), pero sí
          // aporta su convención. Ahí nacía el centavo — 138.08 contra los 138.07
          // que QuickBooks facturó en la Invoice 19614.
          const taxBaseForDoc = await loadOrderMoneyBase(client, id);
          const parity = resolveQbParityTax(
            taxBaseForDoc,
            representedDiscountDollars(taxBaseForDoc),
            taxRate
          );
          let liveTaxTotal = parity.tax;
          console.log(
            `[convert-force] Derived tax = $${liveTaxTotal.toFixed(2)} on taxable base $${parity.taxableBase.toFixed(2)} @ ${taxRate}%`
          );

          // 7e. Update order_summary with tax and corrected totals
          const sumRes = await client.query<{ id: string; totals: any }>(
            `SELECT id, totals FROM order_summary
                         WHERE order_id = $1 AND deleted_at IS NULL
                         ORDER BY version DESC LIMIT 1`,
            [id]
          );
          if (sumRes.rows[0]) {
            const { id: sumId, totals } = sumRes.rows[0];

            // Round the aggregate ONCE. Medusa accumulates tax per line and
            // leaves the decimals hanging (99.98 × 7% → 6.9986); QuickBooks
            // rounds the whole taxable base to the cent and bills 7.00. Since
            // Σ(lineᵢ × rate) === (Σlineᵢ) × rate, rounding the sum here lands
            // on QB's exact figure — verified against SR 27807 and Invoice 18861.
            const qbParityTax = liveTaxTotal; // already rounded once, QB-style

            // Derived from the order's own lines and shipping, NOT from
            // `original_order_total`: on a converted draft that field holds the
            // net with the tax kept separately, while on an edited order it
            // holds the net WITH the tax folded in. Adding the tax to it is
            // wrong in the first case and doubles it in the second.
            const moneyBase = await loadOrderMoneyBase(client, id);
            const resolved = resolvePatchedOrderTotal({
              base: moneyBase,
              posTaxAmount: qbParityTax,
              // Misma fuente que la línea de arriba: el descuento vive en las
              // líneas, no en el agregado del summary.
              discount: representedDiscountDollars(moneyBase),
            });
            if (!resolved.ok) {
              console.error(
                `[convert-force] ❌ Refusing to patch order_summary ${sumId}: ${resolved.reason}. ` +
                  `Leaving the previous total — it is the clamp ceiling for order_money_projection.`
              );
              throw new Error(`order total not derivable: ${resolved.reason}`);
            }
            for (const w of resolved.warnings) {
              console.warn(`[convert-force] ⚠️  ${w}`);
            }
            const newTotal = resolved.total;
            liveTaxTotal = qbParityTax;
            await client.query(
              `UPDATE order_summary SET totals = $1, updated_at = NOW() WHERE id = $2`,
              [
                JSON.stringify({
                  ...totals,
                  tax_total: liveTaxTotal,
                  raw_tax_total: { value: String(liveTaxTotal), precision: 20 },
                  accounting_total: newTotal,
                  raw_accounting_total: {
                    value: String(newTotal),
                    precision: 20,
                  },
                  current_order_total: newTotal,
                  raw_current_order_total: {
                    value: String(newTotal),
                    precision: 20,
                  },
                  pending_difference: newTotal,
                  raw_pending_difference: {
                    value: String(newTotal),
                    precision: 20,
                  },
                }),
                sumId,
              ]
            );
            console.log(
              `[convert-force] ✅ order_summary: tax=$${liveTaxTotal.toFixed(2)} total=$${newTotal.toFixed(2)}`
            );

            // Los TRES campos, o ninguno — ver la nota extensa en
            // `post-edit-sync`. Convertir re-derivaba el total y lo escribía
            // SÓLO en `order_summary`, dejando `metadata.computed_total` con la
            // cifra que le puso `compute-tax` cuando el documento todavía era
            // un estimado. Mientras las dos derivaciones coincidan no se nota;
            // el día que difieran, la lista y el documento se contradicen sin
            // que nada falle. Va en la MISMA transacción que el summary.
            await client.query(
              `UPDATE "order"
                  SET metadata = COALESCE(metadata, '{}') || jsonb_build_object(
                        'computed_total', $1::numeric,
                        'pos_total',      $1::numeric
                      )
                WHERE id = $2`,
              [newTotal, id]
            );
            console.log(
              `[convert-force] ✅ computed_total y pos_total alineados en $${newTotal.toFixed(2)}`
            );

            await fixPaymentCollection(newTotal);
          }
        }
      } finally {
        client.release();
      }
    } catch (taxInjErr: any) {
      // FAIL-CLOSED (descuentos-canonicos-v1): el total derivado acá es el
      // techo del clamp de depósitos y lo que lee la lista — devolver 200 con
      // la derivación fallida es publicar una orden con dinero a medias, la
      // familia exacta de S11432. La orden YA quedó convertida; se responde
      // 500 con el id para que el operador la abra y un save la re-derive.
      console.error(
        `[convert-force] ❌ Derivación canónica falló tras convertir: ${taxInjErr?.message}`
      );
      return void res.status(500).json({
        message: `Order converted but money derivation failed: ${taxInjErr?.message}. Open the order and save it to re-derive.`,
        order_id: id,
        code: "MONEY_DERIVATION_FAILED",
      });
    }

    // Stamp order_placed_at so POS activity log shows correct creation time

    try {
      await fetch(`${base}/admin/orders/${id}`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          metadata: { order_placed_at: new Date().toISOString() },
        }),
      });
      console.log(`[convert-force] ✅ Stamped order_placed_at on order ${id}`);
    } catch (metaErr: any) {
      console.warn(
        `[convert-force] ⚠️ Could not stamp order_placed_at: ${metaErr?.message}`
      );
    }

    return void res.status(200).json({ order: convertedOrder });
  } catch (e: any) {
    console.error("[convert-force]", e?.message);
    res.status(500).json({ message: e?.message ?? "Conversion failed" });
  }
}
