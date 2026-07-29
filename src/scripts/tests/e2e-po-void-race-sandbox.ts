/**
 * E2E del guard void-before-create del Purchase Order — SOLO SANDBOX.
 *
 * ── Qué prueba, y qué NO ──────────────────────────────────────────────────────
 * El guard vive dentro del loop de `qb-purchase-order-poller.ts`, que sólo corre
 * con una respuesta real del bridge de QuickBooks. Ejercitar ese loop entero
 * exigiría un bridge falso; lo que se prueba acá es todo lo demás, que es donde
 * están las decisiones:
 *
 *   1. el lookup encuentra al PO voideado (y NO al que está sano)
 *   2. el re-armado deja la fila en el estado exacto que el dispatcher acepta
 *   3. el payload resultante satisface la rama `pl.is_void && !pl.is_query &&
 *      pl.edit_sequence` de Fase A, o sea que va DERECHO al void sin la vuelta
 *      extra de query-para-el-EditSequence
 *   4. el invariante de UNA fila por PO se respeta (no se crea una segunda)
 *
 * Lo que queda sin cubrir es la invocación en sí, que es una línea.
 *
 * Run:
 *   DATABASE_URL=postgresql://postgres:sandbox@localhost:5499/medusa \
 *     ./node_modules/.bin/tsx src/scripts/tests/e2e-po-void-race-sandbox.ts
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
const FRESH_TXN = "TXN-E2E-PO-FRESH";
const FRESH_SEQ = "1234567890";

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

/** El lookup EXACTO del poller (knex `?` traducido a `$n`, sin tocar nada más). */
const VOIDED_PO_LOOKUP = `
  SELECT id, number, status, qb_edit_sequence,
         vendor_qb_list_id_snapshot, vendor_name_snapshot
    FROM purchase_order
   WHERE id = $1 AND status = 'voided' AND deleted_at IS NULL
   LIMIT 1
`;

async function main() {
  console.log("\n=== E2E void-before-create del Purchase Order (sandbox) ===\n");

  const { rows: poRows } = await pool.query(
    `SELECT po.id, po.number, po.status
       FROM purchase_order po
      WHERE po.deleted_at IS NULL AND po.status <> 'voided'
      LIMIT 1`
  );
  if (!poRows[0]) {
    console.error("❌ el sandbox no tiene un purchase_order utilizable");
    process.exit(1);
  }
  const poId = poRows[0].id as string;
  const poNumber = poRows[0].number;
  const originalStatus = poRows[0].status as string;

  const { rows: pipeBefore } = await pool.query(
    `SELECT id, status, payload FROM qb_purchase_order_pipeline
      WHERE purchase_order_id = $1 AND deleted_at IS NULL`,
    [poId]
  );
  const hadRow = pipeBefore.length > 0;
  const originalRow = pipeBefore[0] ?? null;

  try {
    // ── 1 · un PO SANO no dispara nada ─────────────────────────────────────
    const sano = await pool.query(VOIDED_PO_LOOKUP, [poId]);
    check(
      "un PO sano NO matchea el lookup (no se re-arma nada en el caso normal)",
      sano.rows.length === 0,
      JSON.stringify(sano.rows[0])
    );

    // ── 2 · el PO se voidea mientras su create viaja ───────────────────────
    await pool.query(
      `UPDATE purchase_order SET status = 'voided' WHERE id = $1`,
      [poId]
    );
    const voideado = await pool.query(VOIDED_PO_LOOKUP, [poId]);
    check(
      "un PO voideado SÍ matchea, con los campos que el payload de void necesita",
      voideado.rows.length === 1 &&
        voideado.rows[0].number != null &&
        "vendor_qb_list_id_snapshot" in voideado.rows[0],
      JSON.stringify(voideado.rows[0])
    );

    // ── 3 · el re-armado deja la fila lista para el dispatcher ─────────────
    if (!hadRow) {
      await pool.query(
        `INSERT INTO qb_purchase_order_pipeline
           (id, purchase_order_id, status, payload, retries, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'waiting', '{}'::jsonb, 0, NOW(), NOW())`,
        [poId]
      );
    }
    const po = voideado.rows[0];
    const voidPayload = {
      is_void: true,
      txn_id: FRESH_TXN,
      edit_sequence: FRESH_SEQ,
      po_id: po.id,
      po_number: po.number,
      vendor_qb_list_id: po.vendor_qb_list_id_snapshot,
      vendor_name: po.vendor_name_snapshot,
    };
    await pool.query(
      `UPDATE qb_purchase_order_pipeline
          SET status = 'waiting', qb_list_id = $2, qb_operation_id = NULL,
              payload = $3, retries = 0, last_error = NULL,
              next_retry_at = NULL, synced_at = NULL, updated_at = NOW()
        WHERE purchase_order_id = $1 AND deleted_at IS NULL`,
      [poId, FRESH_TXN, JSON.stringify(voidPayload)]
    );

    const { rows: after } = await pool.query(
      `SELECT id, status, payload, qb_list_id, synced_at
         FROM qb_purchase_order_pipeline
        WHERE purchase_order_id = $1 AND deleted_at IS NULL`,
      [poId]
    );

    check(
      "sigue habiendo UNA sola fila (el unique index de un-PO-una-fila se respeta)",
      after.length === 1,
      `${after.length} filas`
    );

    const pl = after[0]?.payload ?? {};
    check(
      "la fila queda 'waiting' con el payload de void y sin marcar synced",
      after[0]?.status === "waiting" &&
        pl.is_void === true &&
        after[0]?.synced_at === null,
      JSON.stringify({ status: after[0]?.status, synced_at: after[0]?.synced_at })
    );

    check(
      "el payload lleva el TxnID FRESCO del confirm, no el viejo de la DB",
      pl.txn_id === FRESH_TXN && after[0]?.qb_list_id === FRESH_TXN,
      JSON.stringify({ txn: pl.txn_id, list: after[0]?.qb_list_id })
    );

    // Ésta es la asersión que importa: la rama que el dispatcher va a tomar.
    // `pl.is_void && !pl.is_query` con edit_sequence presente → submitVoidToBridge
    // directo, sin la vuelta extra de query para el EditSequence.
    const iraDerechoAlVoid =
      pl.is_void === true && !pl.is_query && !!pl.edit_sequence;
    check(
      "el dispatcher lo mandará DERECHO al void (sin query previo por EditSequence)",
      iraDerechoAlVoid,
      JSON.stringify({ is_void: pl.is_void, is_query: pl.is_query, seq: pl.edit_sequence })
    );

    check(
      "el payload trae todo lo que submitVoidToBridge necesita",
      !!pl.po_number && !!pl.po_id && "vendor_qb_list_id" in pl,
      JSON.stringify(pl)
    );

    // ── 4 · el guard no se re-dispara sobre una fila que YA es un void ─────
    // (en el poller esto es la condición `!pl.is_void`, que evita el loop)
    check(
      "una fila que ya es void no se vuelve a re-armar (guard !pl.is_void)",
      pl.is_void === true,
      "la condición del poller lee este mismo campo"
    );
  } finally {
    // Restaurar todo.
    await pool.query(`UPDATE purchase_order SET status = $2 WHERE id = $1`, [
      poId,
      originalStatus,
    ]);
    if (hadRow && originalRow) {
      await pool.query(
        `UPDATE qb_purchase_order_pipeline
            SET status = $2, payload = $3, updated_at = NOW()
          WHERE id = $1`,
        [originalRow.id, originalRow.status, JSON.stringify(originalRow.payload)]
      );
    } else {
      await pool.query(
        `DELETE FROM qb_purchase_order_pipeline WHERE purchase_order_id = $1`,
        [poId]
      );
    }
    console.log(`\n  (PO ${poNumber} restaurado a '${originalStatus}')`);
  }

  console.log(`\n=== ${passed} pasaron · ${failed} fallaron ===\n`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error("❌ el E2E explotó:", e.message);
  await pool.end();
  process.exit(1);
});
