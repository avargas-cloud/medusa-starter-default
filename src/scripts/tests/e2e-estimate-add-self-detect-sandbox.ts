/**
 * E2E del deadlock de auto-detección del ADD de estimates — SOLO SANDBOX.
 *
 * ── El incidente (2026-08-08 → 2026-08-11) ───────────────────────────────────
 * El consolidator reclama la fila 'estimate' (ADD lazy del POS) como
 * 'processing' y llama a handleDraftOrderUpdated ("MOD primero, CREATE si
 * skipped"). El chequeo de in-flight encontraba LA PROPIA fila reclamada,
 * parqueaba un estimate_mod fantasma detrás de ella y devolvía "coalesced";
 * el consolidator entonces skipeaba el ADD como "Superseded" y el CREATE no
 * corría jamás. 8 estimates + 2 sales orders quedaron invisibles en QB.
 *
 * ── Qué prueba este script (contra la fila REAL de E2993 si existe) ──────────
 *   A. Con excludeRowId (el fix): el handler devuelve "skipped" (→ camino
 *      CREATE) y NO nace ningún mod fantasma.
 *   B. Mutation/control positivo: SIN excludeRowId el deadlock SE REPRODUCE
 *      (mod fantasma con depends_on = fila reclamada). Prueba que el test
 *      detecta el bug — un assert de "no pasó nada" sin esto es vacuo.
 *   C. Serializer (hueco 3): con excludeRowId no se espera a sí mismo
 *      (<1.5s); sin él, espera hasta maxWaitMs (control positivo).
 *   D. Wake-vs-metadata (hueco 2): un estimate_mod despertado cuando el
 *      metadata aún no tiene TxnID resuelve el TxnID desde la fila ADD
 *      confirmada (findConfirmedAddTxnId) y despacha ("scheduled") en vez de
 *      morir "nothing to modify".
 *
 * Todo lo que muta se restaura/borra al final. Aborta si DATABASE_URL no es
 * el sandbox (:5499 / localhost).
 *
 * Run:
 *   DATABASE_URL='postgresql://postgres:sandbox@localhost:5499/medusa' \
 *   REDIS_URL='redis://localhost:6399' \
 *   MEILISEARCH_HOST='http://localhost:7799' MEILISEARCH_API_KEY='sandbox_master_key' \
 *   QB_BRIDGE_URL='http://localhost:9999/disabled' QB_BRIDGE_DISABLED=true \
 *   DISABLE_SCHEDULED_JOBS=true SMTP_DISABLED=true RESEND_API_KEY= \
 *     npx medusa exec ./src/scripts/tests/e2e-estimate-add-self-detect-sandbox.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";

import { getDbPool } from "../../api/utils/db-pool";
import { handleDraftOrderUpdated } from "../../lib/quickbooks/handlers/handle-draft-order-updated";
import {
  findConfirmedAddTxnId,
  findLatestInFlightRow,
} from "../../lib/quickbooks/pipeline/in-flight";
import { withQbSerialized } from "../../lib/quickbooks/qb-serializer";

const DB = process.env.DATABASE_URL ?? "";
if (!/localhost|127\.0\.0\.1/.test(DB) || !/5499/.test(DB)) {
  console.error("❌ Refusing to run: DATABASE_URL is not the :5499 sandbox");
  process.exit(1);
}

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ✅ ${label}`);
  else {
    failures++;
    console.error(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: (m: string) => console.error(`    [handler] ${m}`),
};

export default async function e2eEstimateAddSelfDetect({ container }: ExecArgs) {
  const pool = getDbPool();

  // ── Target: la fila deadlockeada REAL (E2993) o cualquier estimate POS
  //    sin TxnID en metadata con fila 'estimate' viva/skipped.
  const { rows: targets } = await pool.query(
    `SELECT p.id AS row_id, p.order_id, p.status AS orig_status,
            p.error AS orig_error, p.medusa_ref_number
       FROM qb_order_pipeline p
       JOIN "order" o ON o.id = p.order_id
      WHERE p.step = 'estimate'
        AND p.status IN ('skipped', 'waiting')
        AND p.bridge_op_id IS NULL
        AND p.qb_txn_id IS NULL
        AND (o.metadata->>'qb_estimate_txn_id') IS NULL
      ORDER BY (p.error LIKE 'Superseded by append-only%') DESC, p.created_at
      LIMIT 1`
  );
  if (!targets.length) {
    console.error("❌ No suitable estimate row found in sandbox — aborting");
    process.exit(1);
  }
  const target = targets[0];
  console.log(
    `\n🎯 Target: ${target.medusa_ref_number} row=${target.row_id} (orig status='${target.orig_status}')`
  );

  const modCountSql = `SELECT count(*)::int AS n FROM qb_order_pipeline
                        WHERE order_id = $1 AND step = 'estimate_mod'`;
  const tempRowIds: string[] = [];

  try {
    // Simular el claim del consolidator
    await pool.query(
      `UPDATE qb_order_pipeline SET status = 'processing', updated_at = NOW() WHERE id = $1`,
      [target.row_id]
    );

    // ── Test A: con excludeRowId el handler NO se auto-detecta ──────────────
    console.log("\n── Test A: fix activo (excludeRowId = fila reclamada)");
    const before = (await pool.query(modCountSql, [target.order_id])).rows[0].n;
    const outcomeA = await handleDraftOrderUpdated(
      target.order_id,
      container,
      silentLogger,
      { isCron: true, awaitSerialized: true, excludeRowId: target.row_id }
    );
    const afterA = (await pool.query(modCountSql, [target.order_id])).rows[0].n;
    check(
      `outcome === "skipped" (cae al camino CREATE)`,
      outcomeA === "skipped",
      `got "${outcomeA}"`
    );
    check(`no nace mod fantasma (${before} antes, ${afterA} después)`, afterA === before);

    // ── Test B: mutation/control positivo — sin excludeRowId el bug vive ────
    console.log("\n── Test B: control positivo (SIN excludeRowId → deadlock)");
    const outcomeB = await handleDraftOrderUpdated(
      target.order_id,
      container,
      silentLogger,
      { isCron: true, awaitSerialized: true }
    );
    const { rows: phantoms } = await pool.query(
      `SELECT id, status, depends_on FROM qb_order_pipeline
        WHERE order_id = $1 AND step = 'estimate_mod' AND depends_on = $2`,
      [target.order_id, target.row_id]
    );
    check(
      `outcome === "coalesced" (el bug se reproduce)`,
      outcomeB === "coalesced",
      `got "${outcomeB}"`
    );
    check(
      `mod fantasma parqueado con depends_on = fila reclamada`,
      phantoms.length === 1 && phantoms[0].status === "waiting"
    );
    tempRowIds.push(...phantoms.map((r: { id: string }) => r.id));

    // ── Test C: el serializer no se espera a sí mismo ───────────────────────
    console.log("\n── Test C: serializer (hueco 3)");
    let ranWith = false;
    const t0 = Date.now();
    await withQbSerialized(
      `estimate:${target.order_id}`,
      {
        orderId: target.order_id,
        steps: ["estimate"],
        excludeRowId: target.row_id,
      },
      async () => {
        ranWith = true;
      },
      { maxWaitMs: 3000 }
    );
    const elapsedWith = Date.now() - t0;
    check(
      `con excludeRowId: corre sin esperar (${elapsedWith}ms)`,
      ranWith && elapsedWith < 1500
    );

    let ranWithout = false;
    const t1 = Date.now();
    await withQbSerialized(
      `estimate:${target.order_id}`,
      { orderId: target.order_id, steps: ["estimate"] },
      async () => {
        ranWithout = true;
      },
      { maxWaitMs: 3000 }
    );
    const elapsedWithout = Date.now() - t1;
    check(
      `control: sin excludeRowId espera hasta timeout (${elapsedWithout}ms >= 3000)`,
      ranWithout && elapsedWithout >= 3000
    );

    // ── Test D: fallback de TxnID desde la fila ADD confirmada (hueco 2) ────
    console.log("\n── Test D: wake-vs-metadata (fallback findConfirmedAddTxnId)");
    const FAKE_TXN = "E2E-SELFDETECT-FAKE-TXN";
    const { rows: confIns } = await pool.query(
      `INSERT INTO qb_order_pipeline (id, order_id, step, status, qb_txn_id, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'estimate', 'confirmed', $2, NOW(), NOW())
       RETURNING id`,
      [target.order_id, FAKE_TXN]
    );
    tempRowIds.push(confIns[0].id);
    const resolved = await findConfirmedAddTxnId(target.order_id, ["estimate"]);
    check(`findConfirmedAddTxnId resuelve el TxnID de la fila confirmada`, resolved === FAKE_TXN);

    const { rows: modIns } = await pool.query(
      `INSERT INTO qb_order_pipeline (id, order_id, step, status, medusa_ref_number, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'estimate_mod', 'processing', $2, NOW(), NOW())
       RETURNING id`,
      [target.order_id, target.medusa_ref_number]
    );
    tempRowIds.push(modIns[0].id);
    const outcomeD = await handleDraftOrderUpdated(
      target.order_id,
      container,
      silentLogger,
      {
        isCron: true,
        awaitSerialized: true,
        pipelineRowId: modIns[0].id,
        excludeRowId: modIns[0].id,
      }
    );
    // "scheduled" = el fallback encontró TxnID y despachó (el bridge sandbox
    // está muerto, así que la fila termina failed — lo que prueba que PASÓ el
    // punto donde antes moría con "nothing to modify").
    check(
      `outcome === "scheduled" (fallback funcionó; antes: "skipped")`,
      outcomeD === "scheduled",
      `got "${outcomeD}"`
    );

    // ── Sanity: exclusión en findLatestInFlightRow ──────────────────────────
    console.log("\n── Sanity: findLatestInFlightRow");
    const seen = await findLatestInFlightRow(target.order_id, ["estimate"]);
    const excluded = await findLatestInFlightRow(target.order_id, ["estimate"], {
      excludeRowId: target.row_id,
    });
    check(`sin exclusión VE la fila 'processing'`, seen?.id === target.row_id);
    check(`con exclusión NO la ve`, excluded?.id !== target.row_id);
  } finally {
    // ── Cleanup: borrar filas temporales y restaurar la fila target ─────────
    if (tempRowIds.length) {
      await pool.query(`DELETE FROM qb_order_pipeline WHERE id = ANY($1)`, [
        tempRowIds,
      ]);
    }
    await pool.query(
      `UPDATE qb_order_pipeline SET status = $2, error = $3, updated_at = NOW() WHERE id = $1`,
      [target.row_id, target.orig_status, target.orig_error]
    );
    console.log(
      `\n🧹 Cleanup: ${tempRowIds.length} filas temporales borradas; target restaurado a '${target.orig_status}'`
    );
  }

  if (failures > 0) {
    console.error(`\n❌ E2E FAILED — ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\n✅ E2E PASSED — self-detect fix + serializer + TxnID fallback");
}
