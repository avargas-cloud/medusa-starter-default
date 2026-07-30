/**
 * E2E — el PAYLOAD que sale hacia QuickBooks, contra lo que QuickBooks facturó.
 *
 * Todo lo verificado hasta acá miraba el total que el backend GUARDA. Esto mira
 * el otro lado: las líneas que efectivamente se le mandan a QB. Son cosas
 * distintas y pueden discrepar — de hecho discrepaban, y por eso este script
 * existe.
 *
 * Los cuatro caminos del POS usan TRES ensamblados distintos:
 *
 *   1. estimate / draft order      → `qb-draft-order-subscriber.ts:300`
 *        buildQbItems(items TAL CUAL, metadata) + getEffectiveOrderDiscount
 *   2. orden nueva de cero         ┐
 *      convert to order            ├→ `handle-order-placed.ts:272`
 *      edit order save (SO Mod)    ┘  buildQbItems(items con subtotal:undefined,
 *                                     metadata, productTaxableMap) + el mismo resolver
 *   3. invoice / sales receipt     → snapshot de `pos_invoice.discount`
 *                                     (`handle-fulfillment-created.ts:591`)
 *
 * La diferencia del punto 1 no es cosmética: `buildQbItems` cambia de rama según
 * si la línea trae `subtotal`. Con subtotal presente usa ESE como monto de línea;
 * sin él usa `unit_price × qty`. El estimate lo manda y el sales order lo borra
 * a propósito, así que el mismo documento puede producir líneas distintas según
 * qué tipo de documento QB se esté creando.
 *
 * Qué se afirma, por documento:
 *   a. suma de líneas de producto      == "Order Item Subtotal" de QB
 *   b. línea Discount                  == la línea Discount de QB
 *   c. suma − descuento                == Subtotal (header) de QB
 *   d. los TRES ensamblados coinciden entre sí   ← lo que impide que un mismo
 *      documento valga distinto según sea Estimate, Sales Order o Invoice
 *
 * NO le habla a QuickBooks: sólo construye el payload en memoria y lo compara
 * contra `docs/qb-ground-truth-2026-07-30.json`, congelado del bridge el
 * 2026-07-30. Read-only incluso contra la base.
 *
 * Run:
 *   cd backend && env DATABASE_URL=postgresql://postgres:sandbox@localhost:5499/medusa \
 *     REDIS_URL=redis://localhost:6399 MEILISEARCH_HOST=http://localhost:7799 \
 *     MEILISEARCH_API_KEY=sandbox_master_key QB_BRIDGE_DISABLED=true \
 *     DISABLE_SCHEDULED_JOBS=true \
 *     ./node_modules/.bin/medusa exec ./src/scripts/tests/e2e-qb-payload-parity-sandbox.ts
 */
import { readFileSync } from "fs";

import { ContainerRegistrationKeys } from "@medusajs/utils";

import type { ExecArgs } from "@medusajs/framework/types";

import {
  buildQbItems,
  buildQbOrderDiscountLines,
  buildShippingQbItem,
  getEffectiveOrderDiscount,
  resolveProductTaxableMap,
} from "../../lib/quickbooks/order-flow-core";

const CENT = 0.005;

const DOCS = (process.env.DOCS ?? "").trim()
  ? process.env.DOCS!.split(",").map((s) => s.trim())
  : [
      "S11179", "S10897", "S11167", "S11241", "S11064", "S10737",
      "S11242", "S11243", "S10671", "S10949", "S10612", "S11284",
      "S11210", "S10810", "S11042", "S11132", "S11195", "S10948",
      "S11018", "S11177",
    ];

type QbDoc = {
  kind: string;
  ref: string;
  txnId: string;
  grossSubtotal: string | null;
  discount: number;
  netSubtotal: string | null;
  tax: string | null;
  total: string | null;
};

type Assembly = {
  name: string;
  productSum: number;
  discount: number;
  discountLines: number;
};

/**
 * Suma las líneas que QuickBooks totaliza en su `Subtotal`: productos Y envío.
 *
 * El envío estaba excluido y eso hacía fallar S10612 por exactamente −$30.00 en
 * los dos ensamblados — el "Uber $30" es una línea más para QB y entra en su
 * Subtotal. Es la SEGUNDA vez que el mismo envío de la misma orden delata un
 * hueco de un test mío; la primera fue no copiarlo al replicar el documento.
 *
 * `Subtotal` y `Discount` sí se descartan: son los ítems sintéticos de QB que
 * totalizan y descuentan, no montos propios.
 */
function sumSentLines(items: { productName?: string; amount?: number }[]): number {
  const cents = items
    .filter((l) => l.productName !== "Subtotal" && l.productName !== "Discount")
    .reduce((s, l) => s + Math.round(Number(l.amount ?? 0) * 100), 0);
  return cents / 100;
}

export default async function e2eQbPayloadParity({ container }: ExecArgs) {
  const log = console.log;
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const knex = container.resolve("__pg_connection__");

  const truth: QbDoc[] = JSON.parse(
    readFileSync("./docs/qb-ground-truth-2026-07-30.json", "utf8")
  );
  const byTxn = new Map(truth.map((t) => [t.txnId, t]));

  log("\nE2E — payload hacia QuickBooks vs lo que QuickBooks facturó");
  log("=".repeat(96));

  const failures: string[] = [];
  let checked = 0;

  for (const doc of DOCS) {
    const head = await knex
      .raw(
        `SELECT o.id,
                ARRAY(SELECT p.qb_txn_id FROM qb_order_pipeline p
                       WHERE p.order_id = o.id AND p.status = 'confirmed'
                         AND p.step IN ('invoice','sales_receipt','sales_order')) AS txn_ids,
                (SELECT SUM(i.discount)::text FROM pos_invoice i
                  WHERE i.order_id = o.id AND i.status <> 'voided'
                    AND i.deleted_at IS NULL) AS invoice_discount_cents,
                -- Parcialmente facturada: su invoice cubre PARTE del pedido, así
                -- que ni su total ni su descuento son el patrón de la orden. El
                -- Sales Order sí lleva el pedido completo. Misma regla que el
                -- E2E de ciclo de vida — S11132 (40 unidades, 20 facturadas)
                -- volvió a delatar que faltaba acá.
                EXISTS (SELECT 1 FROM order_item oi
                         WHERE oi.order_id = o.id AND oi.version = o.version
                           AND oi.deleted_at IS NULL
                           AND COALESCE(oi.fulfilled_quantity, 0) < oi.quantity)
                  AS partial
           FROM "order" o
          WHERE o.metadata->>'document_number' = ?
          LIMIT 1`,
        [doc]
      )
      .then((r: { rows: any[] }) => r.rows[0]);

    if (!head) {
      log(`⏭️  ${doc} — no está en esta base`);
      continue;
    }
    const found = (head.txn_ids ?? [])
      .map((t: string) => byTxn.get(t))
      .filter((x: QbDoc | undefined): x is QbDoc => !!x && x.total != null);
    const rank = (k: string) =>
      head.partial ? (k === "sales_order" ? 0 : 1) : k === "sales_order" ? 1 : 0;
    const qb = [...found].sort((a, b) => rank(a.kind) - rank(b.kind))[0];
    if (!qb) {
      log(`⏭️  ${doc} — sin verdad de QB congelada`);
      continue;
    }

    // Los MISMOS `fields` que pide cada handler.
    const { data } = await query.graph({
      entity: "order",
      fields: [
        "id",
        "subtotal",
        "discount_total",
        "metadata",
        "items.*",
        "items.variant.*",
        "items.variant.metadata",
        "items.adjustments.*",
        "shipping_methods.*",
      ],
      filters: { id: head.id },
    });
    const order = data?.[0];
    if (!order) continue;
    checked++;

    const assemblies: Assembly[] = [];

    // ── 1. Estimate / draft order ────────────────────────────────────────
    {
      const items = buildQbItems(order.items || [], order.metadata);
      const d = getEffectiveOrderDiscount(order);
      // Los handlers empujan la línea de envío DESPUÉS de las de descuento
      // (`qb-draft-order-subscriber.ts:315`, `handle-order-placed.ts:300`).
      // Omitirla acá dejaba el payload $30 corto en S10612 y parecía un error
      // de cálculo: el envío es una línea más y entra en el Subtotal de QB.
      const ship = buildShippingQbItem((order as any).shipping_methods || []);
      if (ship) items.push(ship);
      const discountLines =
        d > 0
          ? buildQbOrderDiscountLines(
              d,
              Number(order.subtotal || 0) > 0
                ? (d / Number(order.subtotal || 0)) * 100
                : null
            )
          : [];
      assemblies.push({
        name: "estimate",
        productSum: sumSentLines(items),
        discount: Number(
          (discountLines.find((l) => l.productName === "Discount")?.amount ?? 0) as number
        ),
        discountLines: discountLines.length,
      });
    }

    // ── 2. Sales Order (orden nueva · convert · edit save) ───────────────
    {
      const activeItems = (order.items || [])
        .filter((i: any) => (i.quantity ?? 0) > 0)
        .map((i: any) => ({
          ...i,
          unit_price: Number(i.unit_price || 0),
          subtotal: undefined, // lo que hace handle-order-placed a propósito
        }));
      const productTaxableMap = await resolveProductTaxableMap(knex, activeItems);
      const items = buildQbItems(activeItems, order.metadata, productTaxableMap);
      const d = getEffectiveOrderDiscount(order);
      const ship = buildShippingQbItem((order as any).shipping_methods || []);
      if (ship) items.push(ship);
      const discountLines =
        d > 0
          ? buildQbOrderDiscountLines(
              d,
              Number(order.subtotal || 0) > 0
                ? (d / Number(order.subtotal || 0)) * 100
                : null
            )
          : [];
      assemblies.push({
        name: "sales order",
        productSum: sumSentLines(items),
        discount: Number(
          (discountLines.find((l) => l.productName === "Discount")?.amount ?? 0) as number
        ),
        discountLines: discountLines.length,
      });
    }

    // ── 3. Invoice / sales receipt: el snapshot del pos_invoice ──────────
    const invoiceDiscount =
      head.invoice_discount_cents == null
        ? null
        : Number(head.invoice_discount_cents) / 100;

    // ── Aserciones ───────────────────────────────────────────────────────
    const qbDiscount = Number(qb.discount ?? 0);
    const qbGross =
      qb.grossSubtotal != null
        ? Number(qb.grossSubtotal)
        : Number(qb.netSubtotal ?? 0);
    const qbNet = Number(qb.netSubtotal ?? 0);

    const rows: string[] = [];
    let bad = false;

    for (const a of assemblies) {
      const dGross = Math.round((a.productSum - qbGross) * 100) / 100;
      const dDisc = Math.round((a.discount - qbDiscount) * 100) / 100;
      const dNet =
        Math.round((a.productSum - a.discount - qbNet) * 100) / 100;
      const okA =
        Math.abs(dGross) < CENT &&
        Math.abs(dDisc) < CENT &&
        Math.abs(dNet) < CENT;
      if (!okA) bad = true;
      rows.push(
        `     ${a.name.padEnd(12)} líneas $${a.productSum.toFixed(2).padStart(11)}` +
          `${Math.abs(dGross) < CENT ? "  " : ` (${dGross > 0 ? "+" : ""}${dGross.toFixed(2)})`}` +
          `  · desc $${a.discount.toFixed(2).padStart(9)}` +
          `${Math.abs(dDisc) < CENT ? "  " : ` (${dDisc > 0 ? "+" : ""}${dDisc.toFixed(2)})`}` +
          `  · neto $${(a.productSum - a.discount).toFixed(2).padStart(11)}` +
          `${Math.abs(dNet) < CENT ? "" : ` (${dNet > 0 ? "+" : ""}${dNet.toFixed(2)})`}`
      );
      if (!okA) {
        failures.push(
          `${doc}/${a.name}: líneas Δ${dGross.toFixed(2)} · desc Δ${dDisc.toFixed(2)} · neto Δ${dNet.toFixed(2)}`
        );
      }
    }

    // El snapshot del invoice tiene que decir lo mismo que el resolver.
    // Una orden a medio facturar tiene un descuento de invoice PROPORCIONAL a lo
    // facturado — compararlo contra el descuento del pedido completo no mide
    // nada (S11179: 778.40 de sus dos invoices parciales contra 1964.48 del SO).
    if (invoiceDiscount != null && qbDiscount > 0 && !head.partial) {
      const dInv = Math.round((invoiceDiscount - qbDiscount) * 100) / 100;
      rows.push(
        `     ${"invoice snap".padEnd(12)} desc $${invoiceDiscount.toFixed(2).padStart(9)}` +
          `${Math.abs(dInv) < CENT ? "" : ` (${dInv > 0 ? "+" : ""}${dInv.toFixed(2)})`}`
      );
      if (Math.abs(dInv) >= CENT) {
        bad = true;
        failures.push(
          `${doc}/invoice snapshot: desc Δ${dInv.toFixed(2)} vs QB`
        );
      }
    }

    // Y los ensamblados tienen que coincidir ENTRE SÍ — que cada uno acierte
    // contra QB por separado no alcanza si producen documentos distintos.
    const discounts = assemblies.map((a) => a.discount);
    const sums = assemblies.map((a) => a.productSum);
    const spreadD = Math.max(...discounts) - Math.min(...discounts);
    const spreadS = Math.max(...sums) - Math.min(...sums);
    if (spreadD >= CENT || spreadS >= CENT) {
      bad = true;
      failures.push(
        `${doc}: los ensamblados NO coinciden entre sí ` +
          `(descuento Δ${spreadD.toFixed(2)}, líneas Δ${spreadS.toFixed(2)})`
      );
    }

    log(
      `${bad ? "❌" : "✅"} ${doc.padEnd(8)} QB ${qb.kind} ${qb.ref} · ` +
        `bruto $${qbGross.toFixed(2)} · desc $${qbDiscount.toFixed(2)} · neto $${qbNet.toFixed(2)}`
    );
    for (const r of rows) log(r);
  }

  log("=".repeat(96));
  if (failures.length === 0) {
    log(
      `✅ PASS — ${checked} documentos: el payload de los 3 ensamblados coincide ` +
        `entre sí y con lo que QuickBooks facturó.`
    );
    return;
  }
  log(`❌ FAIL — ${failures.length}:`);
  for (const f of failures) log(`   ${f}`);
  throw new Error(`${failures.length} discrepancias de payload contra QuickBooks`);
}
