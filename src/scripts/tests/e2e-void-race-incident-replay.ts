/**
 * Replay del incidente de la POS Invoice 21246 — SOLO SANDBOX.
 *
 * El E2E hermano (`e2e-void-race-sandbox.ts`) llama a los helpers directamente.
 * Este llama al HANDLER REAL (`handleInvoiceVoided`) sobre la misma secuencia de
 * estados que produjo el incidente, que es lo único que prueba que el arreglo
 * funciona por el camino que de verdad recorre un usuario:
 *
 *   t0        se crea el pos_invoice y su fila de pipeline
 *   t0+40s    la fila se despacha al bridge  → status 'submitted', SIN TxnID
 *   t0+41s    el usuario hace VOID           → handleInvoiceVoided()
 *             ANTES: return mudo, nada encolado, factura huérfana en QB
 *             AHORA: deja rastro y difiere; la intención vive en el documento
 *   t0+135s   el ADD confirma con TxnID      → enqueueVoidIfAlreadyVoided()
 *             se materializa el void_invoice con el TxnID recién conocido
 *
 * Aborta si DATABASE_URL no apunta al sandbox (:5499).
 *
 * Run:
 *   DATABASE_URL=postgresql://postgres:sandbox@localhost:5499/medusa \
 *     npx medusa exec ./src/scripts/tests/e2e-void-race-incident-replay.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";

import { getDbPool } from "../../api/utils/db-pool";
import { handleInvoiceVoided } from "../../lib/quickbooks/handlers/handle-invoice-voided";
import { enqueueVoidIfAlreadyVoided } from "../../lib/quickbooks/pipeline/void-intent";

const TAG = "E2E-REPLAY-21246";
const FAKE_TXN = "TXN-REPLAY-1CB7C1";
const FAKE_REF = "99637";

export default async function replayVoidRace({ container }: ExecArgs) {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes(":5499/")) {
    console.error(
      `❌ ABORTA: DATABASE_URL debe apuntar al sandbox (:5499). Recibido: ${url.replace(/:[^:@]+@/, ":***@")}`
    );
    return;
  }

  const logger = container.resolve("logger");
  const orderModule = container.resolve("order");
  const pool = getDbPool();

  let passed = 0;
  let failed = 0;
  const check = (name: string, ok: boolean, detail = "") => {
    if (ok) {
      passed++;
      console.log(`  ✅ ${name}`);
    } else {
      failed++;
      console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
    }
  };

  const cleanup = async () => {
    await pool.query(
      `DELETE FROM qb_order_pipeline WHERE medusa_ref_number LIKE $1`,
      [`${TAG}%`]
    );
  };

  console.log(`\n=== Replay del incidente 21246 (sandbox) ===\n`);
  await cleanup();

  // Una invoice real del sandbox con su orden, para no inventar FKs.
  const { rows: invRows } = await pool.query(
    `SELECT i.id, i.order_id, i.status, i.invoice_number
       FROM pos_invoice i
       JOIN "order" o ON o.id = i.order_id
      WHERE i.deleted_at IS NULL
        AND i.metadata->>'is_sales_receipt' IS DISTINCT FROM 'true'
      LIMIT 1`
  );
  if (!invRows[0]) {
    console.error("❌ el sandbox no tiene una invoice con orden para el replay");
    return;
  }
  const inv = invRows[0];
  const originalStatus = inv.status as string;

  // Se guarda el metadata de la orden para restaurarlo: el handler lo lee para
  // resolver el TxnID, y hay que dejarlo como estaba.
  const orderBefore = await orderModule.retrieveOrder(inv.order_id);
  const originalMeta = { ...(orderBefore.metadata || {}) };

  try {
    // ── t0 · el ADD nace y se despacha, sin TxnID todavía ──────────────────
    console.log("t0 · el ADD de la invoice está EN VUELO (submitted, sin TxnID)\n");

    // La orden NO tiene qb_invoices: es exactamente el estado en que el handler
    // de void no encuentra TxnID que apuntar.
    const metaSinInvoices = { ...originalMeta };
    delete (metaSinInvoices as any).qb_invoices;
    await orderModule.updateOrders(inv.order_id, { metadata: metaSinInvoices });
    await pool.query(
      `UPDATE "order" SET metadata = metadata - 'qb_invoices' WHERE id = $1`,
      [inv.order_id]
    );

    await pool.query(
      `DELETE FROM qb_order_pipeline WHERE reference_id = $1 AND step IN ('invoice','void_invoice')`,
      [inv.id]
    );
    await pool.query(
      `INSERT INTO qb_order_pipeline
         (id, order_id, reference_id, reference_type, step, status, bridge_op_id,
          submitted_at, medusa_ref_number, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'pos_invoice', 'invoice', 'submitted',
               'op-replay', NOW(), $3, NOW(), NOW())`,
      [inv.order_id, inv.id, `${TAG}-ADD`]
    );

    // ── t0+41s · el usuario voidea ─────────────────────────────────────────
    console.log("t0+41s · el usuario hace VOID (el TxnID todavía no existe)\n");
    await pool.query(`UPDATE pos_invoice SET status = 'voided' WHERE id = $1`, [
      inv.id,
    ]);

    let handlerThrew = false;
    try {
      await handleInvoiceVoided(
        { order_id: inv.order_id, invoice_id: inv.id, fulfillment_id: null },
        orderModule,
        logger,
        container
      );
    } catch (e: any) {
      handlerThrew = true;
      console.log(`     (el handler tiró: ${e.message})`);
    }
    check("el handler de void no explota cuando no hay TxnID", !handlerThrew);

    const afterVoid = await pool.query(
      `SELECT step, status FROM qb_order_pipeline
        WHERE reference_id = $1 AND step IN ('void_invoice','void_sales_receipt')`,
      [inv.id]
    );
    check(
      "no encola un void sin TxnID (encolarlo lo mataría con 'missing qb_txn_id')",
      afterVoid.rows.length === 0,
      JSON.stringify(afterVoid.rows)
    );

    // ── t0+135s · el ADD confirma y recién ahí se conoce el TxnID ──────────
    console.log(
      "\nt0+135s · el ADD confirma — es el primer momento con TxnID\n"
    );
    await pool.query(
      `UPDATE qb_order_pipeline
          SET status = 'confirmed', qb_txn_id = $2, qb_ref_number = $3,
              confirmed_at = NOW(), updated_at = NOW()
        WHERE reference_id = $1 AND step = 'invoice'`,
      [inv.id, FAKE_TXN, FAKE_REF]
    );

    const materialized = await enqueueVoidIfAlreadyVoided({
      createStep: "invoice",
      referenceId: inv.id,
      orderId: inv.order_id,
      qbTxnId: FAKE_TXN,
      qbRefNumber: FAKE_REF,
      medusaRefNumber: `${TAG}-VOID`,
      logger,
    });

    const voidRow = (
      await pool.query(
        `SELECT step, status, qb_txn_id, qb_ref_number
           FROM qb_order_pipeline WHERE id = $1`,
        [materialized]
      )
    ).rows[0];

    check(
      "EL ARREGLO: el void se materializa solo, con el TxnID recién conocido",
      !!materialized &&
        voidRow?.step === "void_invoice" &&
        voidRow?.status === "pending" &&
        voidRow?.qb_txn_id === FAKE_TXN,
      JSON.stringify(voidRow)
    );

    check(
      "y queda listo para que el consolidator lo despache (status pending)",
      voidRow?.status === "pending"
    );

    // ── Regresión: si la invoice NO estuviera voideada, no encola nada ─────
    await pool.query(
      `DELETE FROM qb_order_pipeline WHERE reference_id = $1 AND step = 'void_invoice'`,
      [inv.id]
    );
    await pool.query(`UPDATE pos_invoice SET status = $2 WHERE id = $1`, [
      inv.id,
      originalStatus,
    ]);
    const noop = await enqueueVoidIfAlreadyVoided({
      createStep: "invoice",
      referenceId: inv.id,
      orderId: inv.order_id,
      qbTxnId: FAKE_TXN,
      medusaRefNumber: `${TAG}-NOOP`,
      logger,
    });
    check(
      "una invoice sana que confirma NO dispara ningún void (el 99,9% de los casos)",
      noop === null,
      `devolvió ${noop}`
    );
  } finally {
    // Restaurar TODO: es una DB de sandbox, pero un test que ensucia miente
    // en la próxima corrida.
    await pool.query(`UPDATE pos_invoice SET status = $2 WHERE id = $1`, [
      inv.id,
      originalStatus,
    ]);
    await pool.query(
      `DELETE FROM qb_order_pipeline WHERE reference_id = $1 AND step IN ('invoice','void_invoice')`,
      [inv.id]
    );
    await orderModule.updateOrders(inv.order_id, { metadata: originalMeta });
    await cleanup();
  }

  console.log(`\n=== ${passed} pasaron · ${failed} fallaron ===\n`);
  if (failed > 0) process.exitCode = 1;
}
