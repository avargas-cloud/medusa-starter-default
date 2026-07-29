/**
 * Repara el enlace cruzado QB<->POS de las invoices 20226 y 20265.
 *
 * QUE PASO
 * Las dos invoices son documentos distintos de la MISMA orden (S10090, Llonart
 * Homes LLC) y cada una tiene su propia invoice en QuickBooks. Pero el lado
 * Medusa quedo cruzado: la 20226 apunta al documento de la 20265.
 *
 *   POS 20226 ($3.034,24, 30-abr)  ->  QB 19472  TxnID 1C254A-1777588578
 *   POS 20265 ($3.384,83, 05-may)  ->  QB 19487  TxnID 1C310C-1778008551
 *
 * Hoy `pos_invoice.metadata` de la 20226 y sus 2 filas de `qb_order_pipeline`
 * llevan el TxnID de la 20265. Consecuencia: un void o un credit memo emitido
 * desde el POS sobre la 20226 se construiria contra QB 19487 — la factura de
 * la otra. Las filas de la 20265 estan bien y NO se tocan.
 *
 * EVIDENCIA INDEPENDIENTE (QuickBooks, leido por el bridge el 2026-07-28;
 * ningun valor de la DB participo de esta verificacion):
 *   QB 19472  TxnID 1C254A-1777588578  TxnDate 2026-04-30  Subtotal 3034.24
 *   QB 19487  TxnID 1C310C-1778008551  TxnDate 2026-05-05  Subtotal 3384.83
 * Los montos y la hora de creacion matchean 1:1 con cada pos_invoice.
 *
 * ALCANCE: 6 campos en 3 filas. Verificado que ninguna otra fila del pipeline
 * (pagos, credit memos) cuelga del TxnID equivocado.
 *
 * Dry-run:
 *   env DATABASE_URL=$(grep ^DATABASE_URL= .env | cut -d= -f2-) \
 *     npx medusa exec ./src/scripts/fix/repair-invoice-20226-qb-link.ts
 * Apply:
 *   APPLY=1 env DATABASE_URL=$(grep ^DATABASE_URL= .env | cut -d= -f2-) \
 *     npx medusa exec ./src/scripts/fix/repair-invoice-20226-qb-link.ts
 */
import fs from "node:fs";
import path from "node:path";

import type { ExecArgs } from "@medusajs/framework/types";

interface KnexLike {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number }>;
  transaction: () => Promise<
    KnexLike & { commit: () => Promise<void>; rollback: () => Promise<void> }
  >;
}

const APPLY = process.argv.includes("apply") || process.env.APPLY === "1";

const INV_20226 = "01KQG8G8KESSWKWY1V2WKQ31BT";
const INV_20265 = "01KQWRZY3EA26G85C3QMV529RM";
const TXN_19472 = "1C254A-1777588578"; // el documento REAL de la 20226
const TXN_19487 = "1C310C-1778008551"; // el documento REAL de la 20265

const AUDIT = path.join(
  process.cwd(),
  "src/scripts/fix/repair-invoice-20226-qb-link.audit.jsonl"
);

/** Un campo a reparar: donde vive, que dice hoy, que deberia decir. */
interface Op {
  table: "pos_invoice" | "qb_order_pipeline";
  rowId: string;
  label: string;
  field: string;
  before: string | null;
  after: string;
}

const DESIRED: Array<Omit<Op, "before">> = [
  {
    table: "pos_invoice",
    rowId: INV_20226,
    label: "pos_invoice 20226",
    field: "qb_txn_id",
    after: TXN_19472,
  },
  {
    table: "pos_invoice",
    rowId: INV_20226,
    label: "pos_invoice 20226",
    field: "qb_ref_number",
    after: "19472",
  },
  {
    table: "qb_order_pipeline",
    rowId: "569bb894-e50a-4ede-9d47-6628b9aefd46",
    label: "pipeline invoice (20226)",
    field: "qb_txn_id",
    after: TXN_19472,
  },
  {
    table: "qb_order_pipeline",
    rowId: "569bb894-e50a-4ede-9d47-6628b9aefd46",
    label: "pipeline invoice (20226)",
    field: "qb_ref_number",
    after: "19472",
  },
  {
    table: "qb_order_pipeline",
    rowId: "f5aec2c3-1ef5-4a7c-9656-06d8cb6ffb31",
    label: "pipeline invoice_update (20226)",
    field: "qb_txn_id",
    after: TXN_19472,
  },
  {
    table: "qb_order_pipeline",
    rowId: "f5aec2c3-1ef5-4a7c-9656-06d8cb6ffb31",
    label: "pipeline invoice_update (20226)",
    field: "medusa_ref_number",
    after: "INV-20226",
  },
];

/** Estado vivo de las 6 filas involucradas: las 3 a reparar y las 3 testigo. */
async function readState(knex: KnexLike) {
  const inv = await knex.raw(
    `SELECT id, invoice_number, total::text AS total,
            metadata->>'qb_txn_id'     AS qb_txn_id,
            metadata->>'qb_ref_number' AS qb_ref_number
       FROM pos_invoice WHERE id IN (?, ?) AND deleted_at IS NULL`,
    [INV_20226, INV_20265]
  );
  const pipe = await knex.raw(
    `SELECT id, step, status, qb_txn_id, qb_ref_number, reference_id,
            medusa_ref_number
       FROM qb_order_pipeline WHERE reference_id IN (?, ?)
      ORDER BY created_at, seq`,
    [INV_20226, INV_20265]
  );
  return { invoices: inv.rows, pipeline: pipe.rows };
}

/** Lo que NO debe moverse. Si esto cambia, el apply hizo dano colateral. */
function witness(state: Awaited<ReturnType<typeof readState>>): string {
  const inv = state.invoices.find((r) => r.id === INV_20265);
  const rows = state.pipeline.filter((r) => r.reference_id === INV_20265);
  return JSON.stringify(
    {
      invoice_20265: inv,
      pipeline_20265: rows,
      totales: state.invoices.map((r) => `${r.invoice_number}=${r.total}`).sort(),
    },
    null,
    1
  );
}

function currentValue(
  state: Awaited<ReturnType<typeof readState>>,
  op: Omit<Op, "before">
): string | null {
  const row =
    op.table === "pos_invoice"
      ? state.invoices.find((r) => r.id === op.rowId)
      : state.pipeline.find((r) => r.id === op.rowId);
  if (!row) {
    throw new Error(`fila ausente: ${op.table} ${op.rowId} — abortado`);
  }
  return (row[op.field] as string | null) ?? null;
}

/** Compuerta 1: el dry-run y el apply consumen ESTE plan, no dos caminos. */
function buildPlan(state: Awaited<ReturnType<typeof readState>>): Op[] {
  return DESIRED.flatMap((d) => {
    const before = currentValue(state, d);
    return before === d.after ? [] : [{ ...d, before }];
  });
}

export default async function repairInvoice20226QbLink({
  container,
}: ExecArgs): Promise<void> {
  const knex = container.resolve("__pg_connection__") as KnexLike;

  const before = await readState(knex);
  const plan = buildPlan(before);
  const witnessBefore = witness(before);

  // Guarda de integridad: los montos son la prueba de quien es quien.
  const t20226 = before.invoices.find((r) => r.id === INV_20226)?.total;
  const t20265 = before.invoices.find((r) => r.id === INV_20265)?.total;
  if (t20226 !== "303424" || t20265 !== "338483") {
    throw new Error(
      `los totales no son los verificados contra QB (20226=${t20226} 20265=${t20265}) — abortado`
    );
  }

  console.log("\nESTADO ACTUAL");
  for (const r of before.pipeline) {
    console.log(
      `  pipeline ${r.step}/${r.status} txn=${r.qb_txn_id} ref=${r.qb_ref_number} ` +
        `inv=${r.reference_id === INV_20226 ? "20226" : "20265"} medusa_ref=${r.medusa_ref_number}`
    );
  }
  for (const r of before.invoices) {
    console.log(
      `  pos_invoice ${r.invoice_number} txn=${r.qb_txn_id} ref=${r.qb_ref_number}`
    );
  }

  console.log(`\nPLAN (${plan.length} campos)`);
  for (const op of plan) {
    console.log(`  ${op.label} · ${op.field}: ${op.before} -> ${op.after}`);
  }
  if (plan.length === 0) {
    console.log("  nada que hacer — ya esta reparado");
    return;
  }

  if (!APPLY) {
    console.log("\nDRY-RUN — no se escribio nada. APPLY=1 para aplicar.");
    return;
  }

  // Compuerta 5: la auditoria se escribe ANTES de tocar el valor visible.
  fs.appendFileSync(
    AUDIT,
    JSON.stringify({ at: new Date().toISOString(), plan, witnessBefore }) + "\n"
  );

  // Compuerta 4: una transaccion, CAS por campo, conteo verificado.
  const trx = await knex.transaction();
  try {
    for (const op of plan) {
      const res =
        op.table === "pos_invoice"
          ? await trx.raw(
              `UPDATE pos_invoice
                  SET metadata = jsonb_set(metadata, ?::text[], to_jsonb(?::text))
                WHERE id = ?
                  AND metadata->>? IS NOT DISTINCT FROM ?`,
              [`{${op.field}}`, op.after, op.rowId, op.field, op.before]
            )
          : await trx.raw(
              `UPDATE qb_order_pipeline
                  SET ${op.field} = ?, updated_at = NOW()
                WHERE id = ? AND ${op.field} IS NOT DISTINCT FROM ?`,
              [op.after, op.rowId, op.before]
            );
      if (res.rowCount !== 1) {
        throw new Error(
          `CAS fallo en ${op.label}·${op.field} (rowCount=${res.rowCount}): ` +
            `la fila se movio desde la lectura — rollback`
        );
      }
    }
    await trx.commit();
  } catch (err) {
    await trx.rollback();
    throw err;
  }

  // Compuerta 2 + 6: el testigo no se movio, y un plan nuevo converge a cero.
  const after = await readState(knex);
  const witnessAfter = witness(after);
  const residual = buildPlan(after);

  console.log("\nVERIFICACION");
  console.log(
    `  testigo (invoice 20265 + sus filas): ${
      witnessAfter === witnessBefore ? "INTACTO" : "!! SE MOVIO !!"
    }`
  );
  console.log(
    `  plan residual (debe ser 0): ${residual.length}${
      residual.length ? " !! NO CONVERGIO !!" : ""
    }`
  );
  for (const r of after.pipeline) {
    console.log(
      `  pipeline ${r.step}/${r.status} txn=${r.qb_txn_id} ref=${r.qb_ref_number} ` +
        `inv=${r.reference_id === INV_20226 ? "20226" : "20265"} medusa_ref=${r.medusa_ref_number}`
    );
  }
  for (const r of after.invoices) {
    console.log(
      `  pos_invoice ${r.invoice_number} txn=${r.qb_txn_id} ref=${r.qb_ref_number}`
    );
  }

  if (witnessAfter !== witnessBefore || residual.length > 0) {
    throw new Error("verificacion post-apply FALLIDA — revisar a mano");
  }
  console.log(`\nOK — ${plan.length} campos reparados. Auditoria: ${AUDIT}`);
}
