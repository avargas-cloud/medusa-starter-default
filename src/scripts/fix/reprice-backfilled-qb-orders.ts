/**
 * Reprice de las órdenes que un backfill de QB creó SIN tax lines, adjustments
 * ni shipping method: `order_summary` y los totales que calcula la API
 * (`total/tax_total/discount_total/shipping_total`) no coincidían con la
 * verdad de QB que sí vive en `pos_invoice` y `order.metadata.pos_total`
 * (medido 2026-09-11, run `qbsb-20260911`: 1.043 de 1.212 órdenes, residual
 * máximo $1.254,86; la web mostraba el total correcto y "Tax $0.00").
 *
 * Correr (dry-run por default):
 *   env DATABASE_URL=… DISABLE_SCHEDULED_JOBS=true QB_BRIDGE_DISABLED=true \
 *     ./node_modules/.bin/medusa exec ./src/scripts/fix/reprice-backfilled-qb-orders.ts
 * Aplicar:               APPLY=true ECOPOWERTECH_ENV=sandbox …   (sandbox: DATABASE_URL en :5499)
 * Otro run:              RUN_ID=qbsb-xxx …          (default qbsb-20260911)
 * Limitar:               LIMIT=50 …  ·  ORDERS=order_a,order_b …
 *
 * El dry-run deja `.qb-docs-cache/reprice-backfilled-qb-orders_<run>-dryrun.json`.
 * Escribir exige sandbox o el camino explícito de producción —
 * `lib/qb-backfill/target-guard.ts`, acá por env: `TARGET_PRODUCTION=1` +
 * `ECOPOWERTECH_ENV=production` + `CONFIRM_PRODUCTION_RUN=<RUN_ID>`, y el
 * reporte del dry-run previo del MISMO RUN_ID (sin él se niega).
 *
 * PRODUCCIÓN (lo corre el OPERADOR desde su terminal, `! <cmd>`), después del dry-run:
 *
 *   cd backend && nohup env DATABASE_URL="$(grep ^DATABASE_URL= .env|cut -d= -f2-)" \
 *     ECOPOWERTECH_ENV=production DISABLE_SCHEDULED_JOBS=true QB_BRIDGE_DISABLED=true \
 *     APPLY=true TARGET_PRODUCTION=1 RUN_ID=qbsb-prod-20260911 CONFIRM_PRODUCTION_RUN=qbsb-prod-20260911 \
 *     ./node_modules/.bin/medusa exec ./src/scripts/fix/reprice-backfilled-qb-orders.ts \
 *     > .qb-docs-cache/reprice-prod_qbsb-prod-20260911.log 2>&1 &
 *
 *   (nunca la URL literal; tarda más de 2 min → nohup … &)
 *
 * ── Qué escribe (por orden, UNA transacción, mismo molde que
 *    `lib/order-discount/apply-order-discount.ts`) ─────────────────────────────
 *   1. `order_line_item_tax_line`: una por ítem (FL @ 7 / EXEMPT @ 0, o la tasa
 *      efectiva de QB — política en `lib/qb-backfill/sales-order-money.ts`).
 *   2. `order_line_item_adjustment`: el descuento del header repartido por
 *      línea con `allocateOrderDiscount` (fixed), `version` = la de la orden.
 *   3. `order_shipping_method` + `order_shipping` (versión vigente) con el
 *      envío de QB, sin tax lines.
 *   4. `order_summary` (versión vigente): cents exactos de `pos_invoice`.
 * NO toca `pos_invoice*`, `order.metadata`, `qb_order_pipeline`, stock ni
 * reservas. Meili se entera solo (trigger `trg_meili_sync_order_summary`).
 *
 * ── Fuente de cada input ─────────────────────────────────────────────────────
 *   `pos_invoice` (subtotal/discount/shipping/tax/total en cents) +
 *   `pos_invoice_item` (total, taxable). Las líneas de la factura se aparean con
 *   las de la orden por (variant_id, quantity, unit_price) en orden de
 *   `sort_order` — el backfill no linkeó `order_line_item_id`. Si no aparean,
 *   la orden se RECHAZA (nunca se adivina a qué línea va cada impuesto).
 *
 * ── Idempotencia ─────────────────────────────────────────────────────────────
 *   Se saltea la orden cuyo estado ya ES el plan: summary a ≤1¢ de `pos_total`
 *   Y tax lines/adjustments/shipping iguales a los que se escribirían. Un
 *   summary "casualmente" igual con el desglose mal NO se saltea.
 */
import { existsSync, mkdirSync, writeFileSync } from "fs";

import type { ExecArgs, Logger } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, generateEntityId } from "@medusajs/utils";
import type { PoolClient } from "pg";

import { getDbPool } from "../../api/utils/db-pool";
import { assertDryRunEvidence, readJsonFile, resolveWriteTarget } from "../../lib/qb-backfill/target-guard";
import {
  headerFromPosInvoice,
  patchOrderSummaryCents,
  planSalesOrderMoney,
  QB_DISCOUNT_CODE,
  QB_DISCOUNT_DESC,
  raw20,
  type SalesOrderMoneyPlan,
} from "../../lib/qb-backfill/sales-order-money";

const APPLY = process.env.APPLY === "true";
const RUN_ID = process.env.RUN_ID ?? "qbsb-20260911";
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : undefined;
const ONLY = (process.env.ORDERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const TAG = "reprice-backfilled-qb-orders";
const TOLERANCE = 0.011;
const DRY_RUN_REPORT = `.qb-docs-cache/${TAG}_${RUN_ID}-dryrun.json`;

type Target = {
  order_id: string;
  version: number;
  document_number: string | null;
  pos_total: string | null;
  summary_total: string | null;
  inv: { subtotal: string; discount: string; shipping: string; tax: string; total: string };
  inv_items: Array<{ variant_id: string | null; quantity: number; unit_price: string; total: string; taxable: boolean }>;
  order_items: Array<{ item_id: string; variant_id: string | null; quantity: string; unit_price: string }>;
  tax_lines: Array<{ item_id: string; rate: string; code: string }>;
  adjustments: Array<{ item_id: string; amount: string }>;
  shipping: Array<{ amount: string }>;
};

const TARGET_SQL = `
  SELECT o.id AS order_id, o.version, o.metadata->>'document_number' AS document_number,
         o.metadata->>'pos_total' AS pos_total,
         (SELECT s.totals->>'current_order_total' FROM order_summary s
           WHERE s.order_id = o.id AND s.deleted_at IS NULL ORDER BY s.version DESC LIMIT 1) AS summary_total,
         json_build_object('subtotal', pi.subtotal, 'discount', pi.discount, 'shipping', pi.shipping, 'tax', pi.tax, 'total', pi.total) AS inv,
         COALESCE((SELECT json_agg(json_build_object('variant_id', ii.variant_id, 'quantity', ii.quantity, 'unit_price', ii.unit_price,
                                                     'total', ii.total, 'taxable', ii.taxable) ORDER BY ii.sort_order, ii.id)
                     FROM pos_invoice_item ii WHERE ii.invoice_id = pi.id AND ii.deleted_at IS NULL), '[]') AS inv_items,
         COALESCE((SELECT json_agg(json_build_object('item_id', li.id, 'variant_id', li.variant_id, 'quantity', oi.quantity::text,
                                                     'unit_price', li.unit_price::text) ORDER BY li.id)
                     FROM order_item oi JOIN order_line_item li ON li.id = oi.item_id
                    WHERE oi.order_id = o.id AND oi.version = o.version AND oi.deleted_at IS NULL), '[]') AS order_items,
         COALESCE((SELECT json_agg(json_build_object('item_id', t.item_id, 'rate', t.rate::text, 'code', t.code))
                     FROM order_line_item_tax_line t
                    WHERE t.deleted_at IS NULL AND t.item_id IN (SELECT item_id FROM order_item WHERE order_id = o.id)), '[]') AS tax_lines,
         COALESCE((SELECT json_agg(json_build_object('item_id', a.item_id, 'amount', a.amount::text))
                     FROM order_line_item_adjustment a
                    WHERE a.deleted_at IS NULL AND a.version = o.version
                      AND a.item_id IN (SELECT item_id FROM order_item WHERE order_id = o.id)), '[]') AS adjustments,
         COALESCE((SELECT json_agg(json_build_object('amount', sm.amount::text))
                     FROM order_shipping os JOIN order_shipping_method sm ON sm.id = os.shipping_method_id
                    WHERE os.order_id = o.id AND os.version = o.version AND os.deleted_at IS NULL AND sm.deleted_at IS NULL), '[]') AS shipping
    FROM "order" o
    JOIN pos_invoice pi ON pi.order_id = o.id AND pi.deleted_at IS NULL
   WHERE o.deleted_at IS NULL
     AND o.metadata->'qb_backfill'->>'run_id' = $1
   ORDER BY o.metadata->>'document_number'
`;

const cents = (v: unknown): number => Math.round(Number(v ?? 0));

/** Aparea cada línea de la factura con una línea de la orden por (variant, qty, precio); null si no cierra. */
function pairLines(t: Target): Array<{ item_id: string; net_cents: number; taxable: boolean }> | null {
  if (t.inv_items.length !== t.order_items.length) return null;
  const free = [...t.order_items];
  const out: Array<{ item_id: string; net_cents: number; taxable: boolean }> = [];
  for (const ii of t.inv_items) {
    const idx = free.findIndex(
      (oi) => oi.variant_id === ii.variant_id && Number(oi.quantity) === Number(ii.quantity) && cents(Number(oi.unit_price) * 100) === cents(ii.unit_price)
    );
    if (idx === -1) return null;
    const [oi] = free.splice(idx, 1);
    out.push({ item_id: oi!.item_id, net_cents: cents(ii.total), taxable: ii.taxable !== false });
  }
  return out;
}

/** `true` cuando lo que hay en la base ya ES el plan (summary + desglose). */
function alreadyApplied(t: Target, plan: SalesOrderMoneyPlan): boolean {
  const summaryOk = t.summary_total != null && Math.abs(Number(t.summary_total) - plan.summary.total_cents / 100) <= TOLERANCE;
  if (!summaryOk) return false;
  const byItem = new Map(plan.lines.map((l) => [l.key, l]));
  if (t.tax_lines.length !== plan.lines.length) return false;
  for (const tl of t.tax_lines) {
    const want = byItem.get(tl.item_id);
    if (!want || Number(tl.rate) !== want.tax_line.rate || tl.code !== want.tax_line.code) return false;
  }
  const wantAdj = plan.lines.filter((l) => l.adjustment_cents > 0);
  if (t.adjustments.length !== wantAdj.length) return false;
  for (const a of t.adjustments) {
    const want = byItem.get(a.item_id);
    if (!want || cents(Number(a.amount) * 100) !== want.adjustment_cents) return false;
  }
  const shipCents = t.shipping.reduce((s, r) => s + cents(Number(r.amount) * 100), 0);
  if (shipCents !== (plan.shipping?.amount_cents ?? 0) || t.shipping.length > (plan.shipping ? 1 : 0)) return false;
  return true;
}

async function applyPlan(client: PoolClient, t: Target, plan: SalesOrderMoneyPlan): Promise<void> {
  const itemIds = plan.lines.map((l) => l.key);
  await client.query("BEGIN");
  try {
    if (itemIds.length > 0) {
      await client.query(`DELETE FROM order_line_item_tax_line WHERE item_id = ANY($1)`, [itemIds]);
      await client.query(`DELETE FROM order_line_item_adjustment WHERE item_id = ANY($1)`, [itemIds]);
      for (const l of plan.lines) {
        await client.query(
          `INSERT INTO order_line_item_tax_line (id, item_id, code, rate, raw_rate, description, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, NOW(), NOW())`,
          [generateEntityId(undefined, "ordlitxl"), l.key, l.tax_line.code, l.tax_line.rate, raw20(l.tax_line.rate), l.tax_line.description]
        );
        if (l.adjustment_cents > 0) {
          const amount = l.adjustment_cents / 100;
          await client.query(
            `INSERT INTO order_line_item_adjustment
               (id, item_id, code, amount, raw_amount, promotion_id, description, is_tax_inclusive, version, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5::jsonb, NULL, $6, false, $7, NOW(), NOW())`,
            [generateEntityId(undefined, "ordliadj"), l.key, QB_DISCOUNT_CODE, amount, raw20(amount), QB_DISCOUNT_DESC, t.version]
          );
        }
      }
    }
    // Envío: se reemplaza lo de la versión vigente (hard delete: estas órdenes nacieron sin envío).
    await client.query(
      `DELETE FROM order_shipping_method WHERE id IN (SELECT shipping_method_id FROM order_shipping WHERE order_id = $1 AND version = $2)`,
      [t.order_id, t.version]
    );
    await client.query(`DELETE FROM order_shipping WHERE order_id = $1 AND version = $2`, [t.order_id, t.version]);
    if (plan.shipping) {
      const smId = generateEntityId(undefined, "ordsm");
      const amount = plan.shipping.amount_cents / 100;
      await client.query(
        `INSERT INTO order_shipping_method (id, name, amount, raw_amount, is_tax_inclusive, is_custom_amount, created_at, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, false, true, NOW(), NOW())`,
        [smId, plan.shipping.name, amount, raw20(amount)]
      );
      await client.query(
        `INSERT INTO order_shipping (id, order_id, version, shipping_method_id, created_at, updated_at) VALUES ($1, $2, $3, $4, NOW(), NOW())`,
        [generateEntityId(undefined, "ordspmv"), t.order_id, t.version, smId]
      );
    }
    await patchOrderSummaryCents(client, t.order_id, plan.summary);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  }
}

export default async function repriceBackfilledQbOrders({ container }: ExecArgs) {
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER);
  if (APPLY) {
    const target = resolveWriteTarget({ argv: process.argv, env: process.env, databaseUrl: process.env.DATABASE_URL, runId: RUN_ID });
    logger.info(`[${TAG}] destino: ${target.target} (${target.reason})`);
    const dry = existsSync(DRY_RUN_REPORT) ? readJsonFile<Record<string, number>>(DRY_RUN_REPORT) : null;
    assertDryRunEvidence(
      target.target,
      RUN_ID,
      dry ? { path: DRY_RUN_REPORT, cardinality: { targets: dry.targets, would_reprice: dry.would_reprice, skipped: dry.skipped, rejected: dry.rejected } } : null,
      (l) => logger.info(l)
    );
  }
  const pool = getDbPool();
  const all = (await pool.query<Target>(TARGET_SQL, [RUN_ID])).rows;
  const filtered = all.filter((t) => ONLY.length === 0 || ONLY.includes(t.order_id));
  const targets = LIMIT !== undefined ? filtered.slice(0, LIMIT) : filtered;

  const residual = (t: Target) => Math.abs(Number(t.summary_total ?? NaN) - Number(t.pos_total ?? NaN));
  const before = targets.filter((t) => !(residual(t) <= TOLERANCE));
  logger.info(
    `${"═".repeat(72)}\n[${TAG}] ${APPLY ? "APPLY" : "DRY-RUN (nada se escribe)"} · run ${RUN_ID} · ${targets.length} orden(es)` +
      (ONLY.length ? ` · ORDERS=${ONLY.length}` : "") + (LIMIT !== undefined ? ` · LIMIT=${LIMIT}` : "") +
      `\n  antes: ${before.length} con |summary − pos_total| > 1¢ · residual máx $${Math.max(0, ...before.map(residual)).toFixed(2)}\n${"═".repeat(72)}`
  );

  let applied = 0;
  let skipped = 0;
  const rejected: string[] = [];
  const byPolicy = { none: 0, statutory: 0, effective: 0 };
  const client = await pool.connect();
  try {
    for (const t of targets) {
      const head = `[${t.document_number ?? t.order_id}]`;
      const paired = pairLines(t);
      if (!paired) {
        rejected.push(`${head} line_pairing_failed: factura ${t.inv_items.length} línea(s) vs orden ${t.order_items.length}`);
        continue;
      }
      const plan = planSalesOrderMoney(
        paired.map((p) => ({ key: p.item_id, net_cents: p.net_cents, taxable: p.taxable })),
        headerFromPosInvoice(t.inv)
      );
      if (!plan.ok) {
        rejected.push(`${head} ${plan.reason}: ${plan.detail}`);
        continue;
      }
      if (alreadyApplied(t, plan)) {
        skipped++;
        continue;
      }
      byPolicy[plan.rate_policy]++;
      logger.info(
        `${head} summary $${t.summary_total ?? "—"} → $${(plan.summary.total_cents / 100).toFixed(2)} · tax ${plan.rate_policy}` +
          (plan.rate_policy === "effective" ? ` @ ${plan.tax_rate}%` : "") +
          ` $${(plan.summary.tax_cents / 100).toFixed(2)} · desc $${(plan.summary.discount_cents / 100).toFixed(2)} · envío $${(plan.summary.shipping_cents / 100).toFixed(2)}`
      );
      if (!APPLY) continue;
      await applyPlan(client, t, plan);
      applied++;
    }
  } finally {
    client.release();
  }

  // Después (relectura real, no lo que se planeó).
  const after = (await pool.query<Target>(TARGET_SQL, [RUN_ID])).rows.filter((t) => targets.some((x) => x.order_id === t.order_id));
  const stillOff = after.filter((t) => !(residual(t) <= TOLERANCE));
  if (!APPLY) {
    mkdirSync(".qb-docs-cache", { recursive: true });
    writeFileSync(
      DRY_RUN_REPORT,
      JSON.stringify(
        { run_id: RUN_ID, apply: false, targets: targets.length, would_reprice: targets.length - skipped - rejected.length, skipped, rejected: rejected.length, by_policy: byPolicy },
        null,
        2
      )
    );
  }
  logger.info(
    `${"─".repeat(72)}\n${APPLY ? "APLICADO" : "DRY-RUN"} · ${applied} reprecificada(s) · ${skipped} ya estaban · ${rejected.length} rechazada(s)` +
      ` · tasa: statutory ${byPolicy.statutory} / effective ${byPolicy.effective} / sin impuesto ${byPolicy.none}` +
      `\n  después: ${stillOff.length} con |summary − pos_total| > 1¢ · residual máx $${Math.max(0, ...stillOff.map(residual)).toFixed(2)}` +
      (rejected.length ? `\n  rechazadas:\n    ${rejected.slice(0, 20).join("\n    ")}${rejected.length > 20 ? `\n    … +${rejected.length - 20}` : ""}` : "") +
      (APPLY ? "" : `\n  reporte: ${DRY_RUN_REPORT}\nPara aplicar: APPLY=true`) +
      `\n${"─".repeat(72)}`
  );
  await pool.end();
}
