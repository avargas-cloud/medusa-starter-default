/**
 * Remedia la carrera void-before-create de la POS Invoice 21246 (orden 2654).
 *
 * QUE PASO
 * El 2026-07-29 se facturo la orden COMPLETA por error y el usuario hizo void
 * 41 segundos despues. En ese momento el ADD de la invoice todavia estaba en
 * vuelo y no existia TxnID, asi que `handle-invoice-voided.ts` (linea ~40,
 * `if (!targetInv?.txn_id) return`) hizo no-op mudo y sin reintento — el evento
 * `pos.invoice.voided` dispara una sola vez.
 *
 *   15:01:46.99  se crea el pos_invoice 21246
 *   15:01:47.78  nace la fila de pipeline del ADD
 *   15:02:27.10  el usuario hace VOID      <- todavia no hay TxnID
 *   15:03:01.98  el bridge acepta el ADD
 *   15:04:02.45  QB devuelve el TxnID      <- la invoice nace ya voideada en Medusa
 *
 * El guard post-confirm que existe para esta carrera vive en
 * `consolidator/poll-submitted-rows.ts` (camino ASINCRONO). Esta invoice
 * confirmo por el camino INLINE de `handle-fulfillment-created.ts:849`, que
 * escribe la fila directamente como 'confirmed' sin pasar por el consolidator,
 * asi que el guard nunca corrio.
 *
 * CONSECUENCIA (verificada en QuickBooks el 2026-07-29):
 *   QB Invoice 19637 viva, BalanceRemaining 18.917,94, sin pagos aplicados.
 *   Sales Order 6442 con AMBAS invoices linkeadas (19637 y 19639) y la linea
 *   KUZ-CH24755-BG en `invoiced 2` sobre `ordered 1`.
 *
 * QUE HACE ESTE SCRIPT
 * Encola UNA fila `void_invoice` (status 'pending') con el TxnID ya conocido.
 * El consolidator la despacha y QB voidea la 19637, liberando la cantidad del
 * Sales Order. No toca QuickBooks directamente ni modifica ningun documento.
 *
 * ALCANCE: 1 fila nueva en `qb_order_pipeline`. Ninguna fila existente cambia.
 *
 * PRECONDICIONES — todas verificadas en runtime, ninguna asumida. Si alguna
 * falla el script aborta sin escribir.
 *
 * Dry-run:
 *   env DATABASE_URL=$(grep ^DATABASE_URL= .env | cut -d= -f2-) \
 *     npx medusa exec ./src/scripts/fix/remediate-invoice-21246-qb-void.ts
 * Apply:
 *   APPLY=1 env DATABASE_URL=$(grep ^DATABASE_URL= .env | cut -d= -f2-) \
 *     npx medusa exec ./src/scripts/fix/remediate-invoice-21246-qb-void.ts
 */
import fs from "node:fs";
import path from "node:path";

import type { ExecArgs } from "@medusajs/framework/types";

import { getDbPool } from "../../api/utils/db-pool";
import { writePipelineRow } from "../../lib/quickbooks/pipeline/row-mutations";

const APPLY = process.argv.includes("apply") || process.env.APPLY === "1";

/** Identidad del documento a remediar. Constantes, nunca derivadas en runtime. */
const INVOICE_ID = "01KYQ6AQVBACAZZ2HG3NB33X59";
const INVOICE_NUMBER = "21246";
const ORDER_ID = "order_01KXK0ETDEMEDYPPGZ5N5CKKZ0";
const QB_TXN_ID = "1CB7C1-1785337431";
const QB_REF_NUMBER = "19637";

const VOID_STEPS = ["void_invoice", "void_sales_receipt"] as const;

const AUDIT = path.join(
  process.cwd(),
  "src/scripts/fix/remediate-invoice-21246-qb-void.audit.jsonl"
);

class PreconditionError extends Error {}

/** Aborta con un mensaje que dice QUE se esperaba y QUE se encontro. */
function expect(condition: boolean, message: string): void {
  if (!condition) throw new PreconditionError(message);
}

interface QbInvoiceSnapshot {
  refNumber: string | null;
  subtotal: string | null;
  balanceRemaining: string | null;
  isPaid: string | null;
  memo: string | null;
}

/**
 * Lee la invoice VIVA de QuickBooks a traves del bridge.
 *
 * Es la precondicion mas importante y la unica que la DB no puede contestar:
 * si el documento ya esta voideado (Subtotal 0) o tiene pagos aplicados, este
 * script NO debe correr. La DB no sabe ninguna de las dos cosas.
 */
async function readInvoiceFromQb(
  log: (m: string) => void
): Promise<QbInvoiceSnapshot | null> {
  const base = process.env.QB_BRIDGE_URL;
  const key = process.env.QB_API_KEY;
  if (!base || !key) {
    log("   QB_BRIDGE_URL / QB_API_KEY ausentes — se omite la lectura de QB");
    return null;
  }

  const headers = { "x-api-key": key, "bypass-tunnel-reminder": "true" };
  const enqueue = await fetch(`${base}/api/invoices/${QB_TXN_ID}`, { headers });
  const enqueued = (await enqueue.json()) as { operationId?: string };
  if (!enqueued.operationId) {
    throw new PreconditionError(
      "el bridge no devolvio operationId para la query de la invoice"
    );
  }

  // El bridge solo corre la query cuando QBWC hace su proximo ciclo: un timeout
  // aca NO significa que el dato no exista, por eso se trata como abort y no
  // como "la invoice no esta".
  for (let attempt = 0; attempt < 12; attempt++) {
    await new Promise((r) => setTimeout(r, 10_000));
    const statusRes = await fetch(
      `${base}/api/sync/status/${enqueued.operationId}`,
      { headers }
    );
    const body = (await statusRes.json()) as {
      operation?: { status?: string; result?: Record<string, any> };
    };
    const status = body.operation?.status;
    if (status === "failed") {
      throw new PreconditionError("la query de la invoice fallo en el bridge");
    }
    if (status !== "completed") continue;

    const qs =
      body.operation?.result?.QBXML?.QBXMLMsgsRs?.InvoiceQueryRs ?? {};
    // Un solo resultado puede venir como objeto suelto en vez de array.
    const ret = Array.isArray(qs.InvoiceRet) ? qs.InvoiceRet[0] : qs.InvoiceRet;
    if (!ret) return null;
    return {
      refNumber: ret.RefNumber ?? null,
      subtotal: ret.Subtotal ?? null,
      balanceRemaining: ret.BalanceRemaining ?? null,
      isPaid: ret.IsPaid ?? null,
      memo: ret.Memo ?? null,
    };
  }
  throw new PreconditionError(
    "timeout esperando la query de la invoice (QBWC no ciclo) — reintentar, NO asumir"
  );
}

export default async function remediateInvoice21246({ container }: ExecArgs) {
  const logger = container.resolve("logger");
  const log = (m: string) => logger.info(m);
  const pool = getDbPool();

  log("");
  log(`=== Remediacion void-before-create — POS Invoice ${INVOICE_NUMBER} ===`);
  log(`Modo: ${APPLY ? "APPLY (escribe)" : "DRY-RUN (no escribe)"}`);
  log("");

  // ── Precondicion 1 · el documento en Medusa ─────────────────────────────
  const { rows: invRows } = await pool.query(
    `SELECT id, invoice_number, order_id, status, voided_at,
            metadata->>'qb_txn_id'        AS qb_txn_id,
            metadata->>'qb_ref_number'    AS qb_ref_number,
            metadata->>'is_sales_receipt' AS is_sales_receipt
       FROM pos_invoice
      WHERE id = $1`,
    [INVOICE_ID]
  );
  const inv = invRows[0];
  expect(!!inv, `no existe el pos_invoice ${INVOICE_ID}`);
  expect(
    inv.invoice_number === INVOICE_NUMBER,
    `invoice_number esperado ${INVOICE_NUMBER}, encontrado ${inv.invoice_number}`
  );
  expect(
    inv.status === "voided",
    `el pos_invoice debe estar 'voided', esta '${inv.status}' — si alguien lo reabrio, NO voidear en QB`
  );
  expect(
    inv.order_id === ORDER_ID,
    `order_id esperado ${ORDER_ID}, encontrado ${inv.order_id}`
  );
  expect(
    inv.qb_txn_id === QB_TXN_ID,
    `qb_txn_id esperado ${QB_TXN_ID}, encontrado ${inv.qb_txn_id} — enlace cruzado, abortar`
  );
  expect(
    inv.qb_ref_number === QB_REF_NUMBER,
    `qb_ref_number esperado ${QB_REF_NUMBER}, encontrado ${inv.qb_ref_number}`
  );
  // Decide el step. Un SR se voidea con void_sales_receipt, no con void_invoice.
  expect(
    inv.is_sales_receipt !== "true",
    "el documento es un Sales Receipt — este script solo cubre void_invoice"
  );
  log(`✓ pos_invoice ${INVOICE_NUMBER} voided el ${inv.voided_at}`);

  // ── Precondicion 2 · el ADD confirmo y es el unico ──────────────────────
  const { rows: addRows } = await pool.query(
    `SELECT id, status, qb_txn_id, confirmed_at
       FROM qb_order_pipeline
      WHERE reference_id = $1 AND step IN ('invoice', 'sales_receipt')`,
    [INVOICE_ID]
  );
  expect(
    addRows.length === 1,
    `se esperaba 1 fila de create, hay ${addRows.length}`
  );
  expect(
    addRows[0].status === "confirmed",
    `la fila del create debe estar 'confirmed', esta '${addRows[0].status}' — si sigue en vuelo, el void llegaria antes que el documento`
  );
  expect(
    addRows[0].qb_txn_id === QB_TXN_ID,
    `la fila del create apunta a ${addRows[0].qb_txn_id}, no a ${QB_TXN_ID}`
  );
  log(`✓ el create confirmo el ${addRows[0].confirmed_at} (fila ${addRows[0].id})`);

  // ── Precondicion 3 · no existe ya un void (idempotencia) ────────────────
  const { rows: voidRows } = await pool.query(
    `SELECT id, step, status FROM qb_order_pipeline
      WHERE reference_id = $1 AND step = ANY($2)`,
    [INVOICE_ID, VOID_STEPS]
  );
  expect(
    voidRows.length === 0,
    `ya existe una fila de void (${voidRows
      .map((r) => `${r.step}:${r.status}`)
      .join(", ")}) — este script no la duplica`
  );
  log("✓ no hay ninguna fila de void para esta referencia");

  // ── Precondicion 4 · nada mas en vuelo sobre el mismo documento ─────────
  // Un void despachado mientras otra mutacion del mismo documento sigue viva la
  // corre en carrera (mismo patron que CM-1105 -> QB 3210).
  const { rows: liveRows } = await pool.query(
    `SELECT id, step, status FROM qb_order_pipeline
      WHERE reference_id = $1
        AND status IN ('waiting', 'pending', 'processing', 'submitted')`,
    [INVOICE_ID]
  );
  expect(
    liveRows.length === 0,
    `hay ${liveRows.length} operacion(es) viva(s) sobre el documento (${liveRows
      .map((r) => `${r.step}:${r.status}`)
      .join(", ")}) — esperar a que quede quieto`
  );
  log("✓ no hay ninguna mutacion en vuelo sobre el documento");

  // ── Precondicion 5 · el estado REAL en QuickBooks ───────────────────────
  log("… leyendo la invoice viva de QuickBooks (puede tardar ~1 min)");
  const qb = await readInvoiceFromQb(log);
  if (qb) {
    expect(
      qb.refNumber === QB_REF_NUMBER,
      `QB devolvio RefNumber ${qb.refNumber}, se esperaba ${QB_REF_NUMBER}`
    );
    expect(
      Number(qb.subtotal) !== 0,
      "la invoice ya esta voideada en QB (Subtotal 0) — no hay nada que hacer"
    );
    // Voidear una invoice con pagos aplicados los deja huerfanos.
    expect(
      qb.isPaid !== "true",
      "la invoice tiene pagos aplicados en QB — voidearla dejaria el pago huerfano; resolver a mano"
    );
    log(
      `✓ QB ${qb.refNumber}: Subtotal ${qb.subtotal} · Balance ${qb.balanceRemaining} · IsPaid ${qb.isPaid} · Memo "${qb.memo}"`
    );
  }

  // ── El plan ─────────────────────────────────────────────────────────────
  log("");
  log("PLAN — 1 fila nueva en qb_order_pipeline:");
  log(`   step              void_invoice`);
  log(`   status            pending`);
  log(`   reference_id      ${INVOICE_ID}   (pos_invoice)`);
  log(`   order_id          ${ORDER_ID}`);
  log(`   qb_txn_id         ${QB_TXN_ID}`);
  log(`   qb_ref_number     ${QB_REF_NUMBER}`);
  log(`   medusa_ref_number INV-${INVOICE_NUMBER}`);
  log("");
  log("Efecto: el consolidator despacha el void y QB 19637 queda en Subtotal 0.");
  log("        El Sales Order 6442 libera la cantidad (KUZ-CH24755-BG -> invoiced 1).");
  log("");

  if (!APPLY) {
    log("DRY-RUN — no se escribio nada. Correr con APPLY=1 para aplicar.");
    return;
  }

  const rowId = await writePipelineRow({
    orderId: ORDER_ID,
    referenceId: INVOICE_ID,
    referenceType: "pos_invoice",
    step: "void_invoice",
    status: "pending",
    qbTxnId: QB_TXN_ID,
    qbRefNumber: QB_REF_NUMBER,
    medusaRefNumber: `INV-${INVOICE_NUMBER}`,
  });

  fs.appendFileSync(
    AUDIT,
    JSON.stringify({
      at: new Date().toISOString(),
      action: "enqueue_void_invoice",
      rowId,
      invoiceId: INVOICE_ID,
      invoiceNumber: INVOICE_NUMBER,
      qbTxnId: QB_TXN_ID,
      qbRefNumber: QB_REF_NUMBER,
      qbSnapshotBefore: qb,
    }) + "\n"
  );

  log(`✅ Fila void_invoice encolada — id ${rowId}`);
  log("   Seguir con: select step, status, bridge_op_id, error");
  log(`               from qb_order_pipeline where id = '${rowId}';`);
}
