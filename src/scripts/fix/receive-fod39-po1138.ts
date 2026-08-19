/**
 * receive-fod39-po1138.ts
 *
 * Cierra el ciclo de UN documento: `FOD-39`, el Factory Order espejo de
 * PO-1138.
 *
 * POR QUE EXISTE
 * `rebuild-skydance-fos` clasifica un PO como "en transito" mirando el
 * `received_at` de la CABECERA de su Inventory Transfer, y a las 19:27 UTC del
 * 2026-08-19 esa cabecera estaba abierta, asi que PO-1138 recibio un FO draft.
 * Un minuto despues —durante la misma corrida— un operador recibio PO-1138 en
 * Miami (`RCP-1202`, 8 lineas ECTSK, 88 unidades) y el espejo PO→IT marco 13 de
 * las 15 lineas de IT-1045. La cabecera sigue NULL sólo por 2 lineas de
 * `Sample-Product` que no llegaron, o sea que el criterio de cabecera describe
 * mal el estado de los controladores: sus 88 unidades ya estan en Miami.
 *
 * Dejarlo draft no rompe nada HOY —el verificador pasa los 4 invariantes—
 * porque la Cantidad Original derivada absorbe el hueco. Rompe manana: el
 * primero que abra ese draft y lo reciba le acredita +88 a China sin nada que
 * lo debite (el transfer ya salio y ya llego), y China deja de dar On Hand 0.
 *
 * QUE HACE
 * 1. Sube `FOD-39` de draft a submitted (toma el siguiente FO-#### de la
 *    secuencia; no reusa ningun numero liberado — no queda ninguno).
 * 2. Lo recibe por las 88 unidades de sus 8 lineas, fechado con la FECHA DEL
 *    PO, no con hoy. Misma regla que los otros 15 del rebuild: Miami recibe
 *    siempre DESPUES de que el IT salio de China, asi que fechar el ingreso
 *    hoy lo archiva despues del egreso que alimenta y el ledger de China
 *    History dibuja un hundimiento que la bodega nunca tuvo.
 *
 * NO toca `inventory_level`: el credito a China lo hace el workflow de receive,
 * y el re-cero posterior es PASO 4 de `rebuild-skydance-fos` corrido aparte
 * (`SKIP_CLEANUP SKIP_DELETE SKIP_CREATE SKIP_DRAFT`), que pone On Hand en 0
 * absoluto sobre TODOS los ECTSK y resincroniza MeiliSearch. Dos comandos, no
 * uno, a proposito: cada uno es verificable por separado y el segundo ya esta
 * probado en sandbox y en produccion.
 *
 * Idempotente: si `FOD-39` ya no esta en draft, aborta sin escribir.
 *
 * Dry run por defecto. Correr:
 *   env DISABLE_SCHEDULED_JOBS=true APPLY=true DATABASE_URL=... REDIS_URL=... \
 *     ./node_modules/.bin/medusa exec ./src/scripts/fix/receive-fod39-po1138.ts
 */

import type { MedusaContainer } from "@medusajs/framework/types";

import { FACTORY_ORDER_STOCK_LOCATION_ID } from "../../modules/factory-orders/constants";
import { receiveFactoryOrderWorkflow } from "../../workflows/factory-orders/receive-factory-order";
import { submitFactoryOrderWorkflow } from "../../workflows/factory-orders/submit-factory-order";

const DRAFT_NUMBER = "FOD-39";
const PO_NUMBER = "PO-1138";
const IT_NUMBER = "IT-1045";
const SCRIPT_ACTOR = "system_receive_fod39_po1138";

interface KnexRaw {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
}

interface FoRow {
  id: string;
  status: string;
  ordered_at: string | null;
  po_id: string;
  po_ordered_at: string | null;
  it_shipped_at: string | null;
}

interface LineRow {
  id: string;
  product_variant_id: string;
  inventory_item_id: string;
  sku_snapshot: string;
  description_snapshot: string | null;
  qty_ordered: number;
  qty_received: number;
  unit_cost_cents: number;
}

export default async function main({
  container,
}: {
  container: MedusaContainer;
}): Promise<void> {
  const apply = process.env.APPLY === "true";
  const knex = container.resolve("__pg_connection__") as unknown as KnexRaw;

  console.log(`\n${apply ? "APPLY" : "DRY RUN"} — cerrar ${DRAFT_NUMBER} (${PO_NUMBER} / ${IT_NUMBER})\n`);

  const { rows: foRows } = await knex.raw(
    `SELECT fo.id, fo.status, fo.ordered_at,
            po.id AS po_id, po.ordered_at AS po_ordered_at,
            it.shipped_at AS it_shipped_at
       FROM factory_order fo
       JOIN purchase_order po ON po.id = fo.linked_purchase_order_id
       LEFT JOIN inventory_transfer it
         ON it.linked_purchase_order_id = po.id
        AND it.deleted_at IS NULL AND it.voided_at IS NULL
      WHERE fo.draft_number = ? AND fo.deleted_at IS NULL`,
    [DRAFT_NUMBER]
  );
  const fo = (foRows as FoRow[])[0];

  if (!fo) {
    throw new Error(`${DRAFT_NUMBER}: no existe un factory_order vivo con ese draft_number.`);
  }
  if (fo.status !== "draft") {
    console.log(
      `  ${DRAFT_NUMBER} ya esta en status="${fo.status}" — nada que hacer (idempotente).\n`
    );
    return;
  }

  // La MISMA regla de fecha que rebuild-skydance-fos: el PO primero, el
  // embarque del IT como respaldo historico, y jamas `new Date()`.
  const dateSource = fo.po_ordered_at ?? fo.ordered_at ?? fo.it_shipped_at;
  if (!dateSource) {
    throw new Error(
      `${PO_NUMBER}: sin ordered_at del PO ni shipped_at del IT — fechar hoy invertiria el orden del ledger.`
    );
  }
  const receiptDate = new Date(dateSource);

  const { rows: lineRows } = await knex.raw(
    `SELECT id, product_variant_id, inventory_item_id, sku_snapshot,
            description_snapshot, qty_ordered, qty_received, unit_cost_cents
       FROM factory_order_line
      WHERE factory_order_id = ? AND deleted_at IS NULL
      ORDER BY sku_snapshot`,
    [fo.id]
  );
  const lines = lineRows as LineRow[];
  if (lines.length === 0) {
    throw new Error(`${DRAFT_NUMBER}: no tiene lineas vivas.`);
  }

  const pending = lines.filter((l) => l.qty_ordered - (l.qty_received ?? 0) > 0);
  const totalUnits = pending.reduce((s, l) => s + (l.qty_ordered - (l.qty_received ?? 0)), 0);

  console.log(
    `  ${DRAFT_NUMBER} (${fo.id}) status=${fo.status} — ${pending.length} linea(s), ${totalUnits} unidad(es)`
  );
  console.log(`  fecha del documento y del receipt: ${receiptDate.toISOString().slice(0, 10)} (del PO)`);
  for (const l of pending) {
    console.log(
      `    ${l.sku_snapshot.padEnd(20)} qty=${l.qty_ordered - (l.qty_received ?? 0)} @${(l.unit_cost_cents / 100).toFixed(2)}`
    );
  }

  if (!apply) {
    console.log("\n  DRY RUN — no se escribio nada.\n");
    return;
  }

  const { result: submitted } = await submitFactoryOrderWorkflow(container).run({
    input: { fo_id: fo.id, submitted_by_user_id: SCRIPT_ACTOR },
  });
  console.log(`  → submitted as ${submitted.number}`);

  const { result: received } = await receiveFactoryOrderWorkflow(container).run({
    input: {
      fo_id: fo.id,
      fo_number: submitted.number,
      received_by_user_id: SCRIPT_ACTOR,
      stock_location_id: FACTORY_ORDER_STOCK_LOCATION_ID,
      received_at: receiptDate,
      notes: `Mirrors ${PO_NUMBER} / ${IT_NUMBER} (receive-fod39-po1138)`,
      lines: pending.map((l) => ({
        fo_line_id: l.id,
        product_variant_id: l.product_variant_id,
        inventory_item_id: l.inventory_item_id,
        sku_snapshot: l.sku_snapshot,
        description_snapshot: l.description_snapshot,
        qty_received_now: l.qty_ordered - (l.qty_received ?? 0),
        unit_cost_cents_effective: l.unit_cost_cents,
        unit_cost_cents_override: null,
      })),
    },
  });
  console.log(
    `  → received ${received.receipt_number}, fo_status_after=${received.fo_status_after}, ` +
      `total_units_received=${received.total_units_received}`
  );
  console.log(
    `\n  LISTO. China quedo acreditada +${totalUnits}; correr ahora PASO 4+5 de ` +
      `rebuild-skydance-fos para volver a On Hand 0 y resincronizar MeiliSearch.\n`
  );
}
