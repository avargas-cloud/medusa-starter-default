/**
 * E2E (sandbox): la fila que el dispatcher puso en `processing` se ADOPTA.
 *
 * Corre el SQL REAL contra un Postgres REAL — que es el único lugar donde se ve
 * un `uuid = text` roto o un índice parcial que no cubre lo que uno cree. Un
 * unit test con pool falso nunca ejecuta la query y habría pasado igual con el
 * bug puesto.
 *
 * La sección 3 es el CONTROL POSITIVO DEL BUG: comprueba que
 * `claimSalesReceiptAttempt` —el camino viejo— efectivamente devuelve
 * `in_flight` sobre esa misma fila. Sin esa aserción, ver `ok:true` en la
 * adopción no probaría nada: podría estar pasando porque el deadlock nunca
 * existió. Es la lección del 2026-07-30 (un E2E cuyo control negativo el
 * sistema ya consideraba correcto pasa en vacío).
 *
 * Sandbox-only y auto-limpiante: inserta filas con ids sintéticos y las borra
 * al final, pase o falle.
 *
 * Correr:
 *   cd backend && DATABASE_URL='postgresql://postgres:sandbox@localhost:5499/medusa' \
 *     ./node_modules/.bin/tsx src/scripts/tests/e2e-sales-receipt-claim-adoption-sandbox.ts
 */
import { getDbPool } from "../../api/utils/db-pool";
import {
  claimSalesReceiptAttempt,
  adoptSalesReceiptClaim,
} from "../../lib/quickbooks/pipeline/claim-sales-receipt";

const ORDER_ID = "order_E2E_SR_ADOPT";
const REF_ID = "inv_E2E_SR_ADOPT";

let failures = 0;
function assert(name: string, cond: boolean, detail: string): void {
  if (!cond) failures++;
  console.log(`${cond ? "✅" : "❌"} ${name} — ${detail}`);
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL || "";
  if (!/localhost:5499|127\.0\.0\.1:5499/.test(url)) {
    console.error(
      "❌ ABORTADO: este E2E escribe filas y sólo corre contra el sandbox (:5499).\n" +
        `   DATABASE_URL apunta a otro lado. Nunca contra producción.`
    );
    process.exit(2);
  }

  const pool = getDbPool();
  await cleanup(pool);

  try {
    // ── 1. Fixture: la fila tal como la deja runPendingDispatchPass ─────────
    const { rows: ins } = await pool.query(
      `INSERT INTO qb_order_pipeline
         (order_id, reference_id, reference_type, step, status, payload)
       VALUES ($1, $2, 'pos_invoice', 'sales_receipt', 'processing', '{}'::jsonb)
       RETURNING id`,
      [ORDER_ID, REF_ID]
    );
    const rowId = ins[0].id as string;
    console.log(`fixture: fila ${rowId} en 'processing' sin bridge_op_id\n`);

    // ── 2. La adopción la reconoce ─────────────────────────────────────────
    const adopted = await adoptSalesReceiptClaim(rowId, {
      orderId: ORDER_ID,
      referenceId: REF_ID,
    });
    assert(
      "adopta la fila que el dispatcher reclamó",
      adopted.ok && adopted.rowId === rowId,
      adopted.ok
        ? `ok, rowId conservado ⇒ Idempotency-Key sales-receipt:${rowId}`
        : `devolvió ${JSON.stringify(adopted)} — el ADD seguiría sin salir`
    );

    // ── 2b. Regresión 2026-08-21: adopta AUNQUE la fila cargue un
    // bridge_op_id residual de un intento anterior que sí llegó al bridge y
    // falló ahí (ej. QB Error 3180 "item history could not be locked") — el
    // timeout submitted→failed y el claim processing del dispatcher NUNCA
    // limpian ese campo, así que exigirlo NULL dejaba a esas filas trabadas
    // para siempre (INV-21522/21528/21529, prod). Y confirma que el residuo
    // se limpia como parte de la adopción, no que quede arrastrado.
    const { rows: ins2 } = await pool.query(
      `INSERT INTO qb_order_pipeline
         (order_id, reference_id, reference_type, step, status, payload, bridge_op_id)
       VALUES ($1, $2, 'pos_invoice', 'sales_receipt', 'processing', '{}'::jsonb, 'op-stale-failed-attempt')
       RETURNING id`,
      [ORDER_ID, REF_ID + "_stale"]
    );
    const staleRowId = ins2[0].id as string;
    const adoptedStale = await adoptSalesReceiptClaim(staleRowId, {
      orderId: ORDER_ID,
      referenceId: REF_ID + "_stale",
    });
    assert(
      "adopta una fila 'processing' con bridge_op_id residual de un fallo previo",
      adoptedStale.ok && adoptedStale.rowId === staleRowId,
      adoptedStale.ok
        ? "ok — sin esto INV-21522/21528/21529 se hubieran trabado igual"
        : `devolvió ${JSON.stringify(adoptedStale)} — reintroduce el deadlock para filas con fallo previo`
    );
    const { rows: staleCheck } = await pool.query(
      `SELECT bridge_op_id FROM qb_order_pipeline WHERE id = $1`,
      [staleRowId]
    );
    assert(
      "la adopción limpia el bridge_op_id residual",
      staleCheck[0]?.bridge_op_id === null,
      staleCheck[0]?.bridge_op_id === null
        ? "limpio — el submit nuevo no arrastra el operationId muerto"
        : `quedó "${staleCheck[0]?.bridge_op_id}" — el poll del retry pollearía la operación equivocada`
    );

    // ── 3. CONTROL POSITIVO DEL BUG: el camino viejo se auto-detecta ───────
    const oldPath = await claimSalesReceiptAttempt({
      orderId: ORDER_ID,
      referenceId: REF_ID,
      medusaRefNumber: null,
      payload: {},
    });
    assert(
      "el claim VIEJO sobre la misma fila devuelve in_flight (el deadlock existe)",
      !oldPath.ok,
      oldPath.ok
        ? `devolvió ok — el control no vale, el bug no se reproduce acá`
        : `in_flight, como en prod el 2026-08-17 — por eso hace falta la adopción`
    );

    // ── 4. Controles negativos de la adopción ──────────────────────────────
    const wrongRef = await adoptSalesReceiptClaim(rowId, {
      orderId: ORDER_ID,
      referenceId: "inv_QUE_NO_ES",
    });
    assert(
      "NO adopta con reference_id ajeno",
      !wrongRef.ok,
      wrongRef.ok ? "adoptó una fila que no le toca" : "rechazada"
    );

    const wrongOrder = await adoptSalesReceiptClaim(rowId, {
      orderId: "order_QUE_NO_ES",
      referenceId: REF_ID,
    });
    assert(
      "NO adopta con order_id ajeno",
      !wrongOrder.ok,
      wrongOrder.ok ? "adoptó una fila que no le toca" : "rechazada"
    );

    await pool.query(
      `UPDATE qb_order_pipeline SET status='submitted', bridge_op_id='op-fake'
        WHERE id = $1`,
      [rowId]
    );
    const alreadySent = await adoptSalesReceiptClaim(rowId, {
      orderId: ORDER_ID,
      referenceId: REF_ID,
    });
    assert(
      "NO adopta una fila ya submitteada al bridge",
      !alreadySent.ok,
      alreadySent.ok
        ? "adoptaría un ADD ya en vuelo ⇒ documento duplicado en QB"
        : "rechazada (fail-closed)"
    );
  } finally {
    await cleanup(pool);
  }

  console.log(
    `\n${failures === 0 ? "✅ E2E VERDE" : `❌ ${failures} ASERCIÓN(ES) FALLARON`}`
  );
  process.exit(failures > 0 ? 1 : 0);
}

async function cleanup(pool: ReturnType<typeof getDbPool>): Promise<void> {
  await pool.query(`DELETE FROM qb_order_pipeline WHERE order_id = $1`, [
    ORDER_ID,
  ]);
}

main().catch((e) => {
  console.error("❌ E2E explotó:", e?.message || e);
  process.exit(1);
});
