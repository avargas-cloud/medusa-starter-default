/**
 * Fulfillea las órdenes que un backfill de QB creó "Fulfilled" sólo en metadata.
 *
 * Correr (dry-run por default):
 *   env DATABASE_URL=... DISABLE_SCHEDULED_JOBS=true \
 *     ./node_modules/.bin/medusa exec ./src/scripts/fix/fulfill-backfilled-qb-orders.ts
 * Aplicar:              APPLY=true ECOPOWERTECH_ENV=sandbox ...   (sandbox: DATABASE_URL en :5499)
 * Limitar a facturas:   INVOICES=21698,21699 ...
 * Run id:               RUN_ID=fulfill-xxx ...  (default `fulfill-<YYYYMMDD>`; nombra el
 *                       reporte del dry-run `.qb-docs-cache/fulfill-backfilled-qb-orders_<run>-dryrun.json`)
 *
 * Escribir exige sandbox o el camino explícito de producción —
 * `lib/qb-backfill/target-guard.ts`, acá por env: `TARGET_PRODUCTION=1` +
 * `ECOPOWERTECH_ENV=production` + `CONFIRM_PRODUCTION_RUN=<RUN_ID>`, y el
 * reporte del dry-run previo del MISMO RUN_ID (sin él se niega).
 *
 * PRODUCCIÓN (lo corre el OPERADOR desde su terminal, `! <cmd>`), después del dry-run:
 *
 *   cd backend && nohup env DATABASE_URL="$(grep ^DATABASE_URL= .env|cut -d= -f2-)" \
 *     ECOPOWERTECH_ENV=production DISABLE_SCHEDULED_JOBS=true QB_BRIDGE_DISABLED=true \
 *     APPLY=true TARGET_PRODUCTION=1 RUN_ID=fulfill-prod-20260911 CONFIRM_PRODUCTION_RUN=fulfill-prod-20260911 \
 *     ./node_modules/.bin/medusa exec ./src/scripts/fix/fulfill-backfilled-qb-orders.ts \
 *     > .qb-docs-cache/fulfill-prod_fulfill-prod-20260911.log 2>&1 &
 *
 *   (nunca la URL literal; tarda más de 2 min → nohup … &)
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────
 *
 * `backfill-qb-only-docs-2026-06-07` y `backfill-qb-reconciliation-adjustments`
 * crean la orden module-direct con `order_status: "Fulfilled"` en metadata, pero
 * SIN fulfillment: ni fila `fulfillment`, ni link `order_fulfillment`, ni
 * `fulfilled_quantity`. El tab [Unfulfilled] de /invoices no lee metadata — lee
 * el predicado de `_lib/unfulfilled-predicate.ts` — así que esas facturas quedan
 * listadas como pendientes de entrega, cuando la mercadería salió hace meses.
 *
 * ── Qué hace y qué NO ────────────────────────────────────────────────────────
 *
 * Reproduce lo que `createOrderFulfillmentWorkflow` + `markOrderFulfillmentAs
 * DeliveredWorkflow` dejan en la base, MENOS el inventario:
 *
 *   1. `fulfillment` + `fulfillment_item` por el módulo de fulfillment
 *      (no toca stock: el ajuste de inventario vive en el workflow, no acá).
 *   2. Link `order_fulfillment` por el link module — sin él el tab y el botón
 *      "Mark as Picked Up" se contradicen (S11432, 2026-08-20).
 *   3. `orderModule.registerFulfillment` + `registerDelivery` → fulfilled/
 *      delivered_quantity con su `raw_*` BigNumber, como lo hace el core.
 *   4. `pos_invoice.fulfillment_id` y `order.metadata.picked_up_at`.
 *   5. Reindex del documento en Meili (`syncOrders`).
 *
 * NO toca `inventory_level` ni reservas: la decisión del backfill (2026-09-04)
 * fue no mover stock — la mercadería salió hace meses y los conteos posteriores
 * ya lo absorbieron. Por eso no se usa `complete-pickup`, que crea reservas y
 * las consume (descontaría stock hoy).
 *
 * `delivered_at` se backdatea a `order_placed_at` (la fecha del documento QB):
 * la entrega ocurrió con la venta, no cuando se corrió este script.
 *
 * ── Guards (fail-closed, por orden) ──────────────────────────────────────────
 *
 *   - la orden tiene `metadata.manually_imported = true`
 *   - ya tiene un fulfillment vivo linkeado → se saltea (idempotente)
 *   - tiene reservas vivas → se rechaza (es una venta real, no un backfill)
 *   - `fulfilled_quantity > 0` en algún ítem → se rechaza
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import type { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";

import { assertDryRunEvidence, readJsonFile, resolveWriteTarget } from "../../lib/qb-backfill/target-guard";
import { syncOrders } from "../../subscribers/order-meilisearch-sync";

const APPLY = process.env.APPLY === "true";
const ONLY = (process.env.INVOICES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TAG = "fulfill-backfilled-qb-orders";
const AUDIT_FILE = join(__dirname, `${TAG}.audit.jsonl`);
const RUN_ID = process.env.RUN_ID ?? `fulfill-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
const DRY_RUN_REPORT = `.qb-docs-cache/${TAG}_${RUN_ID}-dryrun.json`;

type Target = {
  invoice_id: string;
  invoice_number: string;
  order_id: string;
  document_number: string | null;
  placed_at: string | null;
  qb_txn_id: string | null;
  qb_ref_number: string | null;
  live_fulfillments: number;
  reservations: number;
  fulfilled_sum: string;
  items: Array<{
    line_item_id: string;
    quantity: string;
    title: string;
    sku: string | null;
    inventory_item_id: string | null;
  }>;
};

const TARGET_SQL = `
  SELECT i.id AS invoice_id,
         i.invoice_number,
         i.order_id,
         o.metadata->>'document_number' AS document_number,
         o.metadata->>'order_placed_at' AS placed_at,
         COALESCE(i.metadata->>'qb_txn_id', o.metadata->>'qb_invoice_txn_id') AS qb_txn_id,
         COALESCE(i.metadata->>'qb_ref_number', o.metadata->>'qb_invoice_ref_number') AS qb_ref_number,
         (SELECT count(*) FROM order_fulfillment ofl
            JOIN fulfillment f ON f.id = ofl.fulfillment_id AND f.deleted_at IS NULL AND f.canceled_at IS NULL
           WHERE ofl.order_id = o.id AND ofl.deleted_at IS NULL)::int AS live_fulfillments,
         (SELECT count(*) FROM reservation_item r
            JOIN order_item oi ON oi.item_id = r.line_item_id
           WHERE oi.order_id = o.id AND r.deleted_at IS NULL)::int AS reservations,
         (SELECT COALESCE(sum(oi.fulfilled_quantity), 0)::text FROM order_item oi
           WHERE oi.order_id = o.id AND oi.deleted_at IS NULL) AS fulfilled_sum,
         (SELECT json_agg(json_build_object(
                   'line_item_id', li.id,
                   'quantity', oi.quantity::text,
                   'title', COALESCE(NULLIF(li.variant_title, ''), li.title),
                   'sku', li.variant_sku,
                   'inventory_item_id', pvi.inventory_item_id))
            FROM order_item oi
            JOIN order_line_item li ON li.id = oi.item_id
            LEFT JOIN product_variant_inventory_item pvi
                   ON pvi.variant_id = li.variant_id AND pvi.deleted_at IS NULL
           WHERE oi.order_id = o.id AND oi.deleted_at IS NULL) AS items
    FROM pos_invoice i
    JOIN "order" o ON o.id = i.order_id
   WHERE i.deleted_at IS NULL
     AND i.voided_at IS NULL
     AND i.fulfillment_id IS NULL
     AND o.deleted_at IS NULL
     AND (o.metadata->>'manually_imported')::boolean IS TRUE
   ORDER BY i.invoice_number
`;

const STORE_PICKUP_SQL = `
  SELECT so.id AS shipping_option_id, so.provider_id, sl.id AS location_id
    FROM shipping_option so
    JOIN service_zone sz ON sz.id = so.service_zone_id
    JOIN fulfillment_set fs ON fs.id = sz.fulfillment_set_id
    JOIN location_fulfillment_set lfs ON lfs.fulfillment_set_id = fs.id AND lfs.deleted_at IS NULL
    JOIN stock_location sl ON sl.id = lfs.stock_location_id AND sl.deleted_at IS NULL
   WHERE so.provider_id LIKE 'store-pickup%' AND so.deleted_at IS NULL
   ORDER BY so.created_at
   LIMIT 1
`;

function audit(entry: Record<string, unknown>): void {
  appendFileSync(
    AUDIT_FILE,
    JSON.stringify({ ts: new Date().toISOString(), apply: APPLY, ...entry }) + "\n"
  );
}

export default async function fulfillBackfilledQbOrders({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
  const link = container.resolve(ContainerRegistrationKeys.LINK);
  const orderModule = container.resolve(Modules.ORDER);
  const fulfillmentModule = container.resolve(Modules.FULFILLMENT);

  if (APPLY) {
    const target = resolveWriteTarget({ argv: process.argv, env: process.env, databaseUrl: process.env.DATABASE_URL, runId: RUN_ID });
    logger.info(`[${TAG}] destino: ${target.target} (${target.reason})`);
    const dry = existsSync(DRY_RUN_REPORT) ? readJsonFile<Record<string, number>>(DRY_RUN_REPORT) : null;
    assertDryRunEvidence(
      target.target,
      RUN_ID,
      dry ? { path: DRY_RUN_REPORT, cardinality: { candidates: dry.candidates, would_fulfill: dry.would_fulfill, skipped: dry.skipped, rejected: dry.rejected } } : null,
      (l) => logger.info(l)
    );
  }

  const targets = ((await knex.raw(TARGET_SQL)).rows as Target[]).filter(
    (t) => ONLY.length === 0 || ONLY.includes(t.invoice_number)
  );
  const pickup = ((await knex.raw(STORE_PICKUP_SQL)).rows as Array<{
    shipping_option_id: string;
    provider_id: string;
    location_id: string;
  }>)[0];
  if (!pickup) {
    throw new Error("No store-pickup shipping option linked to a stock location");
  }

  logger.info(
    `${"═".repeat(72)}\n[${TAG}] ${APPLY ? "APPLY" : "DRY-RUN (nada se escribe)"} · ${targets.length} candidata(s)` +
      (ONLY.length ? ` · filtro INVOICES=${ONLY.join(",")}` : "") +
      `\n  pickup: ${pickup.provider_id} · ${pickup.shipping_option_id} · ${pickup.location_id}\n${"═".repeat(72)}`
  );

  let done = 0;
  let skipped = 0;
  let rejected = 0;

  for (const t of targets) {
    const head = `[${t.invoice_number} · ${t.document_number ?? "?"} · QB ${t.qb_ref_number ?? "—"}]`;

    if (t.live_fulfillments > 0) {
      logger.info(`${head} ya tiene ${t.live_fulfillments} fulfillment vivo → skip`);
      skipped++;
      continue;
    }
    if (t.reservations > 0) {
      logger.warn(`${head} RECHAZADA: ${t.reservations} reserva(s) viva(s) — es una venta real, no un backfill`);
      rejected++;
      continue;
    }
    if (Number(t.fulfilled_sum) > 0) {
      logger.warn(`${head} RECHAZADA: fulfilled_quantity=${t.fulfilled_sum} sin fulfillment — estado inconsistente, revisar a mano`);
      rejected++;
      continue;
    }
    if (!t.items?.length) {
      logger.warn(`${head} RECHAZADA: la orden no tiene ítems`);
      rejected++;
      continue;
    }

    const deliveredAt = t.placed_at ? new Date(t.placed_at) : new Date();
    const lines = t.items
      .map((it) => `${it.sku ?? "—"} ×${it.quantity}${it.inventory_item_id ? "" : " (sin inventory item)"}`)
      .join(" · ");
    logger.info(`${head} entregar el ${deliveredAt.toISOString().slice(0, 10)}: ${lines}`);

    if (!APPLY) continue;

    // 1. Fulfillment por módulo: sin reservas, sin ajuste de inventario.
    const fulfillment = await fulfillmentModule.createFulfillment({
      location_id: pickup.location_id,
      provider_id: pickup.provider_id,
      shipping_option_id: pickup.shipping_option_id,
      requires_shipping: false,
      packed_at: deliveredAt,
      delivered_at: deliveredAt,
      created_by: TAG,
      data: { method: "store-pickup", backfilled: true },
      metadata: {
        qb_txn_id: t.qb_txn_id,
        qb_ref_number: t.qb_ref_number,
        backfilled_by: TAG,
        backfilled_at: new Date().toISOString(),
      },
      delivery_address: {},
      items: t.items.map((it) => ({
        line_item_id: it.line_item_id,
        inventory_item_id: it.inventory_item_id ?? undefined,
        quantity: Number(it.quantity),
        title: it.title,
        sku: it.sku ?? "",
        barcode: "",
      })),
      order: { id: t.order_id },
    });

    // 2. Link orden ↔ fulfillment (lo que el predicado del tab exige).
    await link.create([
      {
        [Modules.ORDER]: { order_id: t.order_id },
        [Modules.FULFILLMENT]: { fulfillment_id: fulfillment.id },
      },
    ]);

    // 3. Cantidades fulfilled/delivered con raw_* BigNumber, vía el módulo.
    const items = t.items.map((it) => ({ id: it.line_item_id, quantity: Number(it.quantity) }));
    await orderModule.registerFulfillment({
      order_id: t.order_id,
      reference: Modules.FULFILLMENT,
      reference_id: fulfillment.id,
      created_by: TAG,
      items,
    });
    await orderModule.registerDelivery({
      order_id: t.order_id,
      reference: Modules.FULFILLMENT,
      reference_id: fulfillment.id,
      created_by: TAG,
      items,
    });

    // 4. La factura apunta al fulfillment; la orden registra la entrega.
    await knex.raw(`UPDATE pos_invoice SET fulfillment_id = ?, updated_at = NOW() WHERE id = ?`, [
      fulfillment.id,
      t.invoice_id,
    ]);
    const order = await orderModule.retrieveOrder(t.order_id);
    await orderModule.updateOrders([
      {
        id: t.order_id,
        metadata: {
          ...(order.metadata ?? {}),
          picked_up_at: deliveredAt.toISOString(),
          picked_up_by: TAG,
          pickup_pending: false,
          pickup_pending_invoice_id: null,
        },
      },
    ]);

    // 5. Meili ve el documento nuevo sin esperar al reconciler.
    try {
      await syncOrders([t.order_id], container, logger);
    } catch (err) {
      logger.warn(`${head} reindex Meili falló (no fatal, el reconciler lo toma): ${(err as Error).message}`);
    }

    audit({
      invoice_number: t.invoice_number,
      invoice_id: t.invoice_id,
      order_id: t.order_id,
      fulfillment_id: fulfillment.id,
      delivered_at: deliveredAt.toISOString(),
      items,
    });
    logger.info(`${head} ✅ ${fulfillment.id}`);
    done++;
  }

  if (!APPLY) {
    mkdirSync(".qb-docs-cache", { recursive: true });
    writeFileSync(
      DRY_RUN_REPORT,
      JSON.stringify({ run_id: RUN_ID, apply: false, candidates: targets.length, would_fulfill: targets.length - skipped - rejected, skipped, rejected }, null, 2)
    );
  }
  logger.info(
    `${"─".repeat(72)}\n${APPLY ? "APLICADO" : "DRY-RUN"} · run ${RUN_ID} · ${done} fulfilleada(s) · ${skipped} ya estaban · ${rejected} rechazada(s)` +
      (APPLY ? `\naudit: ${AUDIT_FILE}` : `\nreporte: ${DRY_RUN_REPORT}\nPara aplicar: APPLY=true`) +
      `\n${"─".repeat(72)}`
  );
}
