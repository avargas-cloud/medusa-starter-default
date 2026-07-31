/**
 * e2e-write-check-claim-sandbox.ts
 *
 * Prueba el claim atómico de `write_check` contra un Postgres REAL (sandbox).
 * Un unit test con un pool falso no sirve acá: lo que se está probando es que
 * PostgreSQL, con el índice único parcial `uq_qb_pipeline_write_check_live`,
 * deje pasar exactamente un ganador entre requests concurrentes. El SQL es el
 * sujeto del test, así que tiene que correr de verdad.
 *
 * Llama a las funciones EXPORTADAS por la ruta (`claim-write-check.ts`), nunca a
 * una copia — un test contra una reimplementación no prueba nada del código vivo.
 *
 * Incluye control negativo: al final borra el índice, repite el caso de
 * concurrencia y verifica que SIN el índice aparecen múltiples ganadores. Un test
 * que nunca se vio fallar no es un test.
 *
 * Uso (NUNCA contra producción — aborta si la URL no es la del sandbox):
 *   env DATABASE_URL="postgres://postgres:sandbox@127.0.0.1:5499/medusa" \
 *     ./node_modules/.bin/tsx src/scripts/tests/e2e-write-check-claim-sandbox.ts
 */
import { Pool } from "pg";

import {
  claimWriteCheckAttempt,
  releaseWriteCheckClaim,
  writeCheckIdempotencyKey,
} from "../../lib/quickbooks/pipeline/claim-write-check";
import { writePipelineRow } from "../../lib/quickbooks/qb-pipeline";

const INDEX_SQL = `
  CREATE UNIQUE INDEX IF NOT EXISTS uq_qb_pipeline_write_check_live
    ON qb_order_pipeline (reference_id)
   WHERE step = 'write_check'
     AND reference_id IS NOT NULL
     AND status NOT IN ('failed', 'skipped')
`;

const REF = `cpay_E2ECLAIM${Date.now().toString(36).toUpperCase()}`;

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail: string): void {
  if (ok) {
    passed++;
    console.log(`  ✅ ${name} — ${detail}`);
  } else {
    failed++;
    console.log(`  ❌ ${name} — ${detail}`);
  }
}

async function claimMany(n: number) {
  // Promise.all lanza las n llamadas sin await intermedio: se solapan de verdad.
  return Promise.all(
    Array.from({ length: n }, () =>
      claimWriteCheckAttempt({
        referenceId: REF,
        medusaRefNumber: "Refund E2E-CLAIM",
        payload: { bankAccountId: "bank_e2e", txnDate: "2026-07-31" },
      })
    )
  );
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!/127\.0\.0\.1:5499|localhost:5499/.test(url)) {
    console.error(
      `ABORT: DATABASE_URL no apunta al sandbox (:5499). Recibido: ${url.replace(/:[^:@]*@/, ":***@")}`
    );
    process.exit(2);
  }
  const pool = new Pool({ connectionString: url });

  const rowsFor = async (): Promise<Array<{ id: string; status: string }>> => {
    const { rows } = await pool.query(
      `SELECT id, status FROM qb_order_pipeline
        WHERE step='write_check' AND reference_id=$1 ORDER BY created_at`,
      [REF]
    );
    return rows;
  };

  try {
    await pool.query(INDEX_SQL);
    console.log(`\nReferencia sintética: ${REF}\n`);

    // ── A. Concurrencia: 8 requests simultáneos, un solo cheque ───────────────
    console.log("A. 8 claims concurrentes sobre el mismo refund");
    const a = await claimMany(8);
    const winners = a.filter((r) => r.ok);
    const rejected = a.filter((r) => !r.ok);
    check(
      "un solo ganador",
      winners.length === 1,
      `ganadores=${winners.length} rechazados=${rejected.length}`
    );
    check(
      "los rechazados dicen in_flight",
      rejected.every((r) => !r.ok && r.reason === "in_flight"),
      `motivos=${[...new Set(rejected.map((r) => (r.ok ? "?" : r.reason)))].join(",")}`
    );
    check(
      "una sola fila en la tabla",
      (await rowsFor()).length === 1,
      `filas=${(await rowsFor()).length}`
    );
    const firstRowId =
      winners.length === 1 && winners[0].ok ? winners[0].rowId : "";

    // ── B. Un reintento tras fallo REUSA la fila (misma idempotency key) ──────
    console.log("\nB. El ADD falla y el operador reintenta");
    await releaseWriteCheckClaim(firstRowId, "Bridge enqueue failed: E2E");
    const afterRelease = await rowsFor();
    check(
      "la fila queda failed",
      afterRelease.length === 1 && afterRelease[0].status === "failed",
      `status=${afterRelease[0]?.status}`
    );
    const retry = await claimWriteCheckAttempt({
      referenceId: REF,
      medusaRefNumber: "Refund E2E-CLAIM",
      payload: { bankAccountId: "bank_e2e", txnDate: "2026-07-31" },
    });
    check(
      "el reintento reusa la MISMA fila",
      retry.ok && retry.rowId === firstRowId && retry.reused,
      `rowId igual=${retry.ok && retry.rowId === firstRowId}`
    );
    check(
      "⇒ misma idempotency key (el bridge dedupea un ADD ambiguo)",
      retry.ok &&
        writeCheckIdempotencyKey(retry.rowId) ===
          writeCheckIdempotencyKey(firstRowId),
      retry.ok ? writeCheckIdempotencyKey(retry.rowId) : "n/a"
    );

    // ── C. Un cheque confirmado bloquea para siempre ──────────────────────────
    console.log("\nC. Con el cheque ya confirmado");
    await pool.query(
      `UPDATE qb_order_pipeline SET status='confirmed' WHERE id=$1`,
      [firstRowId]
    );
    const afterConfirmed = await claimWriteCheckAttempt({
      referenceId: REF,
      medusaRefNumber: "Refund E2E-CLAIM",
      payload: {},
    });
    check(
      "no se puede reclamar un segundo cheque",
      !afterConfirmed.ok,
      afterConfirmed.ok ? "RECLAMÓ (mal)" : "rechazado in_flight"
    );

    // ── D. Un revert (skipped) SÍ permite un refund nuevo, con key nueva ──────
    console.log("\nD. Tras un revert que dejó la fila skipped");
    await pool.query(
      `UPDATE qb_order_pipeline SET status='skipped' WHERE id=$1`,
      [firstRowId]
    );
    const afterSkipped = await claimWriteCheckAttempt({
      referenceId: REF,
      medusaRefNumber: "Refund E2E-CLAIM",
      payload: {},
    });
    check(
      "se puede reclamar de nuevo",
      afterSkipped.ok,
      afterSkipped.ok ? "reclamado" : "rechazado (mal)"
    );
    check(
      "y la key es NUEVA (fila nueva ⇒ generación nueva)",
      afterSkipped.ok && afterSkipped.rowId !== firstRowId,
      afterSkipped.ok
        ? `${writeCheckIdempotencyKey(afterSkipped.rowId)} ≠ ${writeCheckIdempotencyKey(firstRowId)}`
        : "n/a"
    );

    // ── E. Camino feliz real: el claim y el writePipelineRow son la MISMA fila ─
    //    Si `writePipelineRow('submitted')` insertara una fila nueva en vez de
    //    actualizar la reclamada, el refund quedaría con dos filas y el índice
    //    haría explotar la ruta en producción. Esta es la interacción que corre
    //    de verdad cada vez que alguien aprieta "Send to QB".
    console.log("\nE. Camino feliz: claim → bridge OK → writePipelineRow");
    await pool.query(
      `DELETE FROM qb_order_pipeline WHERE step='write_check' AND reference_id=$1`,
      [REF]
    );
    const happy = await claimWriteCheckAttempt({
      referenceId: REF,
      medusaRefNumber: "Refund E2E-CLAIM",
      payload: { bankAccountId: "bank_e2e", txnDate: "2026-07-31" },
    });
    const submittedRowId = await writePipelineRow({
      referenceId: REF,
      referenceType: "customer_payment",
      step: "write_check",
      status: "submitted",
      bridgeOpId: "op-e2e-fake",
      medusaRefNumber: "Refund E2E-CLAIM",
      payload: { bankAccountId: "bank_e2e", txnDate: "2026-07-31" },
    });
    const happyRows = await rowsFor();
    check(
      "sigue habiendo UNA sola fila",
      happyRows.length === 1,
      `filas=${happyRows.length}`
    );
    check(
      "writePipelineRow actualizó la fila reclamada (no insertó otra)",
      happy.ok && submittedRowId === happy.rowId,
      `claim=${happy.ok ? happy.rowId.slice(0, 8) : "n/a"} submitted=${submittedRowId.slice(0, 8)}`
    );
    check(
      "y quedó submitted con su bridge_op_id",
      happyRows[0]?.status === "submitted",
      `status=${happyRows[0]?.status}`
    );

    // ── CONTROL NEGATIVO: sin el índice, el test A tiene que ROMPERSE ─────────
    console.log("\nCONTROL NEGATIVO: mismo caso A con el índice borrado");
    await pool.query(
      `DELETE FROM qb_order_pipeline WHERE step='write_check' AND reference_id=$1`,
      [REF]
    );
    await pool.query(`DROP INDEX IF EXISTS uq_qb_pipeline_write_check_live`);
    const ctl = await claimMany(8);
    const ctlWinners = ctl.filter((r) => r.ok).length;
    check(
      "sin índice aparecen VARIOS ganadores (el test A prueba algo)",
      ctlWinners > 1,
      `ganadores=${ctlWinners} (si fuera 1, el caso A pasaría por otra razón)`
    );
  } finally {
    // Restaurar SIEMPRE el índice y limpiar los rastros del test.
    await pool.query(
      `DELETE FROM qb_order_pipeline WHERE step='write_check' AND reference_id=$1`,
      [REF]
    );
    await pool.query(INDEX_SQL);
    const { rows: idx } = await pool.query(
      `SELECT 1 FROM pg_indexes WHERE indexname='uq_qb_pipeline_write_check_live'`
    );
    console.log(
      `\nLimpieza: filas del test borradas · índice restaurado=${idx.length === 1}`
    );
    await pool.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("E2E crashed:", e);
  process.exit(1);
});
