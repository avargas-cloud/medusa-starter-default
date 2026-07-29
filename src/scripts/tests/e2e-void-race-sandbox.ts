/**
 * E2E de la carrera void-before-create — SOLO SANDBOX.
 *
 * Ejercita las funciones REALES (`enqueueVoidIfAlreadyVoided`, `findVoidBlockers`)
 * contra una base Postgres de verdad, que es donde viven los invariantes que los
 * unit tests no pueden probar: el índice único parcial, el SQL del gate con sus
 * dos exclusiones, y la resolución del step correcto por tipo de documento.
 *
 * Aborta si la DATABASE_URL no apunta al sandbox (puerto 5499).
 *
 * Run:
 *   DATABASE_URL=postgresql://postgres:sandbox@localhost:5499/medusa \
 *     ./node_modules/.bin/tsx src/scripts/tests/e2e-void-race-sandbox.ts
 */
import { Pool } from "pg";

const URL = process.env.DATABASE_URL ?? "";
if (!URL.includes(":5499/")) {
  console.error(
    `❌ ABORTA: DATABASE_URL debe apuntar al sandbox (:5499). Recibido: ${URL.replace(/:[^:@]+@/, ":***@")}`
  );
  process.exit(1);
}

const pool = new Pool({ connectionString: URL });

/** Marca para poder limpiar todo lo que crea este script, y nada más. */
const TAG = "E2E-VOID-RACE";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function q(sql: string, params: unknown[] = []) {
  return pool.query(sql, params);
}

async function cleanup() {
  await q(`DELETE FROM qb_order_pipeline WHERE medusa_ref_number LIKE $1`, [
    `${TAG}%`,
  ]);
}

async function main() {
  console.log(`\n=== E2E void-before-create (sandbox) ===\n`);
  await cleanup();

  // Se toman documentos REALES del sandbox para no inventar FKs.
  const { rows: invRows } = await q(
    `SELECT id, order_id FROM pos_invoice
      WHERE deleted_at IS NULL AND metadata->>'is_sales_receipt' IS DISTINCT FROM 'true'
      LIMIT 1`
  );
  const { rows: srRows } = await q(
    `SELECT id, order_id FROM pos_invoice
      WHERE deleted_at IS NULL AND metadata->>'is_sales_receipt' = 'true' LIMIT 1`
  );
  const { rows: cmRows } = await q(
    `SELECT id FROM pos_credit_memo WHERE deleted_at IS NULL LIMIT 1`
  );
  const { rows: ordRows } = await q(
    `SELECT id FROM "order" WHERE status = 'canceled' LIMIT 1`
  );

  if (!invRows[0] || !cmRows[0] || !ordRows[0]) {
    console.error("❌ el sandbox no tiene los documentos base para el test");
    process.exit(1);
  }

  const invoiceId = invRows[0].id as string;
  const invoiceOrderId = invRows[0].order_id as string;
  const srId = (srRows[0]?.id as string) ?? null;
  const cmId = cmRows[0].id as string;
  const canceledOrderId = ordRows[0].id as string;

  const { enqueueVoidIfAlreadyVoided } = await import(
    "../../lib/quickbooks/pipeline/void-intent"
  );
  const { findVoidBlockers } = await import(
    "../../lib/quickbooks/pipeline/document-quiescence"
  );
  const silent = { info: () => {}, warn: () => {} };

  // ── 1 · Materialización por tipo de documento ─────────────────────────────
  console.log("1 · Materialización del void al confirmar el ADD\n");

  // -- invoice
  const invStatusBefore = (
    await q(`SELECT status FROM pos_invoice WHERE id = $1`, [invoiceId])
  ).rows[0].status;
  await q(`UPDATE pos_invoice SET status = 'voided' WHERE id = $1`, [invoiceId]);

  const rowId = await enqueueVoidIfAlreadyVoided({
    createStep: "invoice",
    referenceId: invoiceId,
    orderId: invoiceOrderId,
    qbTxnId: "TXN-E2E-INVOICE",
    qbRefNumber: "99001",
    medusaRefNumber: `${TAG}-INV`,
    logger: silent,
  });
  const invVoid = (
    await q(
      `SELECT step, status, qb_txn_id FROM qb_order_pipeline WHERE id = $1`,
      [rowId]
    )
  ).rows[0];
  check(
    "invoice voideada → se encola void_invoice con el TxnID recién conocido",
    !!rowId &&
      invVoid?.step === "void_invoice" &&
      invVoid?.status === "pending" &&
      invVoid?.qb_txn_id === "TXN-E2E-INVOICE",
    JSON.stringify(invVoid)
  );

  // -- idempotencia: segunda llamada no duplica
  const dupId = await enqueueVoidIfAlreadyVoided({
    createStep: "invoice",
    referenceId: invoiceId,
    orderId: invoiceOrderId,
    qbTxnId: "TXN-E2E-INVOICE",
    qbRefNumber: "99001",
    medusaRefNumber: `${TAG}-INV`,
    logger: silent,
  });
  const invCount = Number(
    (
      await q(
        `SELECT COUNT(*) c FROM qb_order_pipeline
          WHERE reference_id = $1 AND step = 'void_invoice'`,
        [invoiceId]
      )
    ).rows[0].c
  );
  check(
    "llamarlo dos veces NO duplica la fila",
    dupId === null && invCount === 1,
    `dupId=${dupId} count=${invCount}`
  );

  // -- documento NO voideado → no encola nada
  await q(`UPDATE pos_invoice SET status = $2 WHERE id = $1`, [
    invoiceId,
    invStatusBefore,
  ]);
  await q(`DELETE FROM qb_order_pipeline WHERE reference_id = $1 AND step = 'void_invoice'`, [
    invoiceId,
  ]);
  const noneId = await enqueueVoidIfAlreadyVoided({
    createStep: "invoice",
    referenceId: invoiceId,
    orderId: invoiceOrderId,
    qbTxnId: "TXN-E2E-INVOICE",
    medusaRefNumber: `${TAG}-INV`,
    logger: silent,
  });
  check(
    "documento NO voideado → no encola nada (el caso normal)",
    noneId === null,
    `devolvió ${noneId}`
  );

  // -- sales receipt discrimina por metadata, no por el step del create
  if (srId) {
    const srBefore = (
      await q(`SELECT status FROM pos_invoice WHERE id = $1`, [srId])
    ).rows[0].status;
    await q(`UPDATE pos_invoice SET status = 'voided' WHERE id = $1`, [srId]);
    const srRowId = await enqueueVoidIfAlreadyVoided({
      createStep: "sales_receipt",
      referenceId: srId,
      orderId: null,
      qbTxnId: "TXN-E2E-SR",
      medusaRefNumber: `${TAG}-SR`,
      logger: silent,
    });
    const srVoid = (
      await q(`SELECT step FROM qb_order_pipeline WHERE id = $1`, [srRowId])
    ).rows[0];
    check(
      "sales receipt → void_sales_receipt (no void_invoice)",
      srVoid?.step === "void_sales_receipt",
      JSON.stringify(srVoid)
    );
    await q(`UPDATE pos_invoice SET status = $2 WHERE id = $1`, [srId, srBefore]);
  } else {
    console.log("  ⏭️  sin sales receipt en el sandbox — caso omitido");
  }

  // -- credit memo
  const cmBefore = (
    await q(`SELECT status FROM pos_credit_memo WHERE id = $1`, [cmId])
  ).rows[0].status;
  await q(`UPDATE pos_credit_memo SET status = 'voided' WHERE id = $1`, [cmId]);
  const cmRowId = await enqueueVoidIfAlreadyVoided({
    createStep: "credit_memo",
    referenceId: cmId,
    orderId: null,
    qbTxnId: "TXN-E2E-CM",
    medusaRefNumber: `${TAG}-CM`,
    logger: silent,
  });
  const cmVoid = (
    await q(`SELECT step, qb_txn_id FROM qb_order_pipeline WHERE id = $1`, [
      cmRowId,
    ])
  ).rows[0];
  check(
    "credit memo voideado → void_credit_memo",
    cmVoid?.step === "void_credit_memo" && cmVoid?.qb_txn_id === "TXN-E2E-CM",
    JSON.stringify(cmVoid)
  );
  await q(`UPDATE pos_credit_memo SET status = $2 WHERE id = $1`, [
    cmId,
    cmBefore,
  ]);

  // -- sales order / estimate: se keyean por order_id, reference_id NULL
  const soRowId = await enqueueVoidIfAlreadyVoided({
    createStep: "sales_order",
    referenceId: null,
    orderId: canceledOrderId,
    qbTxnId: "TXN-E2E-SO",
    medusaRefNumber: `${TAG}-SO`,
    logger: silent,
  });
  const soVoid = (
    await q(
      `SELECT step, reference_id, order_id FROM qb_order_pipeline WHERE id = $1`,
      [soRowId]
    )
  ).rows[0];
  check(
    "orden cancelada → void_sales_order keyeado por order_id con reference_id NULL",
    soVoid?.step === "void_sales_order" &&
      soVoid?.reference_id === null &&
      soVoid?.order_id === canceledOrderId,
    JSON.stringify(soVoid)
  );

  const estRowId = await enqueueVoidIfAlreadyVoided({
    createStep: "estimate",
    referenceId: null,
    orderId: canceledOrderId,
    qbTxnId: "TXN-E2E-EST",
    medusaRefNumber: `${TAG}-EST`,
    logger: silent,
  });
  const estVoid = (
    await q(`SELECT step FROM qb_order_pipeline WHERE id = $1`, [estRowId])
  ).rows[0];
  check(
    "draft cancelado → void_estimate",
    estVoid?.step === "void_estimate",
    JSON.stringify(estVoid)
  );

  // ── 2 · El índice único rechaza un duplicado insertado a mano ─────────────
  console.log("\n2 · El índice único parcial es la garantía dura\n");

  let indexRejected = false;
  let indexError = "";
  try {
    await q(
      `INSERT INTO qb_order_pipeline
         (id, order_id, reference_id, reference_type, step, status, qb_txn_id,
          medusa_ref_number, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'credit_memo', 'void_credit_memo',
               'pending', 'TXN-DUP', $3, NOW(), NOW())`,
      [null, cmId, `${TAG}-DUP`]
    );
  } catch (e: any) {
    indexRejected = true;
    indexError = e.message;
  }
  check(
    "un void_credit_memo duplicado insertado a mano es RECHAZADO por el índice",
    indexRejected && /uq_qb_pipeline_void_by_ref|duplicate key/.test(indexError),
    indexError.slice(0, 120)
  );

  let orderIndexRejected = false;
  let orderIndexError = "";
  try {
    await q(
      `INSERT INTO qb_order_pipeline
         (id, order_id, reference_id, step, status, qb_txn_id,
          medusa_ref_number, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, NULL, 'void_sales_order',
               'pending', 'TXN-DUP-SO', $2, NOW(), NOW())`,
      [canceledOrderId, `${TAG}-DUP-SO`]
    );
  } catch (e: any) {
    orderIndexRejected = true;
    orderIndexError = e.message;
  }
  check(
    "un void_sales_order duplicado (clave por order_id) también es rechazado",
    orderIndexRejected &&
      /uq_qb_pipeline_void_by_order|duplicate key/.test(orderIndexError),
    orderIndexError.slice(0, 120)
  );

  // ── 3 · El gate de quiescencia contra Postgres real ───────────────────────
  console.log("\n3 · Gate de quiescencia (SQL real)\n");

  const voidRowId = (
    await q(
      `SELECT id FROM qb_order_pipeline WHERE reference_id = $1 AND step = 'void_credit_memo'`,
      [cmId]
    )
  ).rows[0].id as string;

  // Sin nada vivo → no bloquea.
  const clean = await findVoidBlockers(pool, {
    voidStep: "void_credit_memo",
    rowId: voidRowId,
    referenceId: cmId,
    orderId: null,
  });
  check(
    "documento quieto → el void despacha (0 bloqueantes)",
    clean.length === 0,
    JSON.stringify(clean)
  );

  // Auto-bloqueo: la propia fila de void NO puede bloquearse.
  check(
    "el void NO se bloquea a sí mismo",
    !clean.some((b: any) => b.id === voidRowId)
  );

  // Con un credit_memo_mod vivo creado ANTES → bloquea.
  await q(
    `INSERT INTO qb_order_pipeline
       (id, order_id, reference_id, reference_type, step, status,
        medusa_ref_number, created_at, updated_at)
     VALUES (gen_random_uuid(), NULL, $1, 'credit_memo', 'credit_memo_mod',
             'submitted', $2, NOW() - INTERVAL '1 hour', NOW())`,
    [cmId, `${TAG}-MOD`]
  );
  const blocked = await findVoidBlockers(pool, {
    voidStep: "void_credit_memo",
    rowId: voidRowId,
    referenceId: cmId,
    orderId: null,
  });
  check(
    "con un credit_memo_mod EN VUELO → el void queda bloqueado (la carrera CM-1105)",
    blocked.length === 1 && blocked[0].step === "credit_memo_mod",
    JSON.stringify(blocked)
  );

  // Una mutación creada DESPUÉS del void no bloquea (rompe el empate).
  await q(
    `DELETE FROM qb_order_pipeline WHERE medusa_ref_number = $1`,
    [`${TAG}-MOD`]
  );
  await q(
    `INSERT INTO qb_order_pipeline
       (id, order_id, reference_id, reference_type, step, status,
        medusa_ref_number, created_at, updated_at)
     VALUES (gen_random_uuid(), NULL, $1, 'credit_memo', 'credit_memo_mod',
             'submitted', $2, NOW() + INTERVAL '1 hour', NOW())`,
    [cmId, `${TAG}-MOD-LATER`]
  );
  const later = await findVoidBlockers(pool, {
    voidStep: "void_credit_memo",
    rowId: voidRowId,
    referenceId: cmId,
    orderId: null,
  });
  check(
    "una mutación creada DESPUÉS del void no lo bloquea (sin deadlock)",
    later.length === 0,
    JSON.stringify(later)
  );

  // Una fila terminal (failed sin next_retry_at) no bloquea.
  await q(`DELETE FROM qb_order_pipeline WHERE medusa_ref_number = $1`, [
    `${TAG}-MOD-LATER`,
  ]);
  await q(
    `INSERT INTO qb_order_pipeline
       (id, order_id, reference_id, reference_type, step, status, next_retry_at,
        medusa_ref_number, created_at, updated_at)
     VALUES (gen_random_uuid(), NULL, $1, 'credit_memo', 'credit_memo_mod',
             'failed', NULL, $2, NOW() - INTERVAL '1 hour', NOW())`,
    [cmId, `${TAG}-DEAD`]
  );
  const dead = await findVoidBlockers(pool, {
    voidStep: "void_credit_memo",
    rowId: voidRowId,
    referenceId: cmId,
    orderId: null,
  });
  check(
    "una fila terminal (failed sin retry) NO bloquea — nadie la va a correr",
    dead.length === 0,
    JSON.stringify(dead)
  );

  // ── 4 · Delta v2 · void_payment ──────────────────────────────────────────
  console.log("\n4 · void_payment (delta v2)\n");

  const { rows: payRows } = await q(
    `SELECT id, metadata FROM customer_payment
      WHERE deleted_at IS NULL
        AND COALESCE(metadata->>'qb_source','') <> 'sales_receipt'
      LIMIT 1`
  );
  if (payRows[0]) {
    const payId = payRows[0].id as string;
    const payMetaBefore = payRows[0].metadata ?? {};

    // Voideado en Medusa, SIN operación de borrado en QB = la carrera.
    await q(
      `UPDATE customer_payment
          SET metadata = COALESCE(metadata,'{}'::jsonb) || '{"qb_sync_status":"voided"}'::jsonb
                       - 'qb_void_operation_id'
        WHERE id = $1`,
      [payId]
    );
    const payVoidId = await enqueueVoidIfAlreadyVoided({
      createStep: "payment",
      referenceId: payId,
      orderId: null,
      qbTxnId: "TXN-E2E-PAY",
      medusaRefNumber: `${TAG}-PAY`,
      logger: silent,
    });
    const payVoid = (
      await q(`SELECT step, status, qb_txn_id FROM qb_order_pipeline WHERE id = $1`, [
        payVoidId,
      ])
    ).rows[0];
    check(
      "pago voideado con su ADD en vuelo → se materializa void_payment (TxnDel)",
      payVoid?.step === "void_payment" && payVoid?.qb_txn_id === "TXN-E2E-PAY",
      JSON.stringify(payVoid)
    );

    // Con la operación de borrado ya estampada, NO se re-encola: el TxnDel
    // ya salió y repetirlo pegaría contra un documento que no existe.
    await q(
      `DELETE FROM qb_order_pipeline WHERE reference_id = $1 AND step = 'void_payment'`,
      [payId]
    );
    await q(
      `UPDATE customer_payment
          SET metadata = COALESCE(metadata,'{}'::jsonb) || '{"qb_void_operation_id":"op-ya-borrado"}'::jsonb
        WHERE id = $1`,
      [payId]
    );
    const alreadyDeleted = await enqueueVoidIfAlreadyVoided({
      createStep: "payment",
      referenceId: payId,
      orderId: null,
      qbTxnId: "TXN-E2E-PAY",
      medusaRefNumber: `${TAG}-PAY2`,
      logger: silent,
    });
    check(
      "un pago cuyo TxnDel YA salió no se vuelve a borrar",
      alreadyDeleted === null,
      `devolvió ${alreadyDeleted}`
    );

    // Un pago embebido en un Sales Receipt no tiene ReceivePayment propio.
    await q(
      `UPDATE customer_payment
          SET metadata = COALESCE(metadata,'{}'::jsonb)
                       || '{"qb_sync_status":"voided","qb_source":"sales_receipt"}'::jsonb
                       - 'qb_void_operation_id'
        WHERE id = $1`,
      [payId]
    );
    const srPay = await enqueueVoidIfAlreadyVoided({
      createStep: "payment",
      referenceId: payId,
      orderId: null,
      qbTxnId: "TXN-E2E-PAY",
      medusaRefNumber: `${TAG}-PAY3`,
      logger: silent,
    });
    check(
      "un pago embebido en un Sales Receipt NO se borra (se voidea el SR)",
      srPay === null,
      `devolvió ${srPay}`
    );

    await q(`UPDATE customer_payment SET metadata = $2::jsonb WHERE id = $1`, [
      payId,
      JSON.stringify(payMetaBefore),
    ]);
  } else {
    console.log("  ⏭️  sin customer_payment en el sandbox — caso omitido");
  }

  // ── 5 · Delta v2 · el gate del void_payment ──────────────────────────────
  console.log("\n5 · Gate del void_payment\n");

  const { rows: gateRows } = await q(
    `SELECT id FROM customer_payment WHERE deleted_at IS NULL LIMIT 1`
  );
  if (gateRows[0]) {
    const gPayId = gateRows[0].id as string;
    await q(`DELETE FROM qb_order_pipeline WHERE medusa_ref_number LIKE $1`, [
      `${TAG}%`,
    ]);
    const { rows: vp } = await q(
      `INSERT INTO qb_order_pipeline
         (id, order_id, reference_id, reference_type, step, status, qb_txn_id,
          medusa_ref_number, created_at, updated_at)
       VALUES (gen_random_uuid(), NULL, $1, 'customer_payment', 'void_payment',
               'pending', 'TXN-G', $2, NOW(), NOW())
       RETURNING id`,
      [gPayId, `${TAG}-GATE`]
    );
    const vpRowId = vp[0].id as string;

    await q(
      `INSERT INTO qb_order_pipeline
         (id, order_id, reference_id, reference_type, step, status,
          medusa_ref_number, created_at, updated_at)
       VALUES (gen_random_uuid(), NULL, $1, 'customer_payment',
               'payment_method_change', 'submitted', $2,
               NOW() - INTERVAL '1 hour', NOW())`,
      [gPayId, `${TAG}-PMC`]
    );
    const payBlockers = await findVoidBlockers(pool, {
      voidStep: "void_payment",
      rowId: vpRowId,
      referenceId: gPayId,
      orderId: null,
    });
    check(
      "un payment_method_change en vuelo bloquea el TxnDel del pago",
      payBlockers.length === 1 &&
        payBlockers[0].step === "payment_method_change",
      JSON.stringify(payBlockers)
    );
  }

  // ── Limpieza ─────────────────────────────────────────────────────────────
  await cleanup();
  const leftovers = Number(
    (
      await q(
        `SELECT COUNT(*) c FROM qb_order_pipeline WHERE medusa_ref_number LIKE $1`,
        [`${TAG}%`]
      )
    ).rows[0].c
  );
  check("limpieza: no quedan filas del test", leftovers === 0, `${leftovers}`);

  console.log(`\n=== ${passed} pasaron · ${failed} fallaron ===\n`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error("❌ el E2E explotó:", e.message);
  await cleanup().catch(() => {});
  await pool.end();
  process.exit(1);
});
