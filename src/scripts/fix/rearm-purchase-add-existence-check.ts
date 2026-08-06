/**
 * Re-arma un ADD de compra (vendor_bill_add / item_receipt_add) que quedó
 * `failed` con la duda de si QuickBooks alcanzó a commitear el documento.
 *
 * ── El caso que lo originó (VB-1082 / PO-1111, 2026-08-05) ───────────────────
 * QBWC devolvió `HRESULT 0x8004041C` DESPUÉS de que QuickBooks ya había
 * guardado el Bill. El bridge trata ese HRESULT como permanente, el
 * clasificador (`error-classifier.ts`) no lo reconoce y cae en `permanent`, y
 * la fila quedó `failed` con `next_retry_at = NULL` — dormida para siempre —
 * mientras el Bill existía en QB con TxnID 1CC54C-1785955489.
 *
 * ── Qué hace (y qué NO hace) ────────────────────────────────────────────────
 * NO escribe el TxnID a mano. Escribir a mano el TxnID, el EditSequence y los
 * `qb_txn_line_id` de cada línea es exactamente el trabajo que ya hace
 * `completeVendorBillAdd()` — replicarlo en un script es duplicar lógica de
 * dinero sin sus tests.
 *
 * Lo que hace es ARMAR el existence-check que el pipeline ya tiene:
 *   1. Marca `__purchase_add_existence_check: true` en el payload de la fila.
 *   2. La devuelve a `pending` (o `waiting` si su dependencia no está resuelta).
 *   3. Espeja la fila legacy (`qb_vendor_bill_pipeline`) a `waiting`.
 *
 * A partir de ahí el consolidator hace todo solo:
 *   dispatch → `POST /api/bills/query` (READ-ONLY, ventana = txn_date)
 *            → `completePurchaseAddExistenceCheck`
 *              · si el documento EXISTE  → lo adopta (`completeVendorBillAdd`):
 *                TxnID + EditSequence + RefNumber + `qb_txn_line_id` por línea,
 *                `vendor_bill.status='synced'`, fila `confirmed`. Sin ADD nuevo.
 *              · si NO existe → `markPurchaseAddVerifiedAbsent` y recién ahí
 *                despacha el ADD real.
 *   Y al quedar `confirmed`, `runWakeDependentsPass` destraba sola la cadena
 *   que estaba detrás (el PO Mod y el Bill siguiente).
 *
 * Es el mismo camino que el botón "Retry" del Purchase Pipeline
 * (`qb-pipeline/[id]/retry` pasa `requireExistenceCheck = true`). Este script
 * existe para poder correrlo con dry-run, con las precondiciones verificadas y
 * sin depender de que el operador acierte el botón — y para servir filas que
 * el botón no alcanza (por ejemplo un `item_receipt_add` dormido).
 *
 * Uso (desde backend/):
 *   env DATABASE_URL=$(grep ^DATABASE_URL= .env|cut -d= -f2-) \
 *     ./node_modules/.bin/tsx src/scripts/fix/rearm-purchase-add-existence-check.ts <row-uuid>
 *   ... mismo comando + `--apply` para escribir.
 *
 * SAFETY:
 *   - Dry-run por defecto; `--apply` es la única vía de escritura.
 *   - No toca QuickBooks. Ni una sola llamada al bridge sale de este script:
 *     la consulta la hace el consolidator, por el camino auditado.
 *   - Idempotente: re-correrlo sobre una fila ya confirmada es un no-op ruidoso.
 *   - Reversible: lo único que escribe es estado de pipeline, ningún dato contable.
 */
import { Client } from "pg";

const EXISTENCE_CHECK_KEY = "__purchase_add_existence_check";
const SUPPORTED_STEPS = ["vendor_bill_add", "item_receipt_add"] as const;
const REARMABLE_STATUSES = ["failed", "failed_permanent", "error"] as const;
const REASON =
  "Re-armado manual: el ADD falló con un error de nivel QBWC, así que el resultado en QuickBooks es desconocido. Se verifica la existencia antes de reintentar.";

interface PipelineRow {
  id: string;
  seq: number;
  step: string;
  status: string;
  reference_id: string | null;
  reference_type: string | null;
  order_id: string | null;
  depends_on: string | null;
  retry_count: number;
  error: string | null;
  payload: Record<string, unknown> | null;
  parent_status: string | null;
  parent_step: string | null;
}

function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const rowId = args.find((a) => !a.startsWith("--"));

  if (!rowId) {
    fail(
      "Falta el id de la fila de qb_order_pipeline.\n" +
        "  Uso: rearm-purchase-add-existence-check.ts <row-uuid> [--apply]"
    );
  }
  if (!/^[0-9a-f-]{36}$/i.test(rowId)) {
    fail(`'${rowId}' no parece un uuid de qb_order_pipeline.`);
  }
  const url = process.env.DATABASE_URL;
  if (!url) fail("DATABASE_URL no está seteada.");

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<PipelineRow>(
      `SELECT r.id, r.seq, r.step, r.status, r.reference_id, r.reference_type,
              r.order_id, r.depends_on, r.retry_count, r.error, r.payload,
              parent.status AS parent_status, parent.step AS parent_step
         FROM qb_order_pipeline r
         LEFT JOIN qb_order_pipeline parent ON parent.id = r.depends_on
        WHERE r.id = $1::uuid`,
      [rowId]
    );
    const row = rows[0];
    if (!row) fail(`No existe la fila ${rowId} en qb_order_pipeline.`);

    console.log(`\nFila #${row.seq}  ${row.step}`);
    console.log(`  id          ${row.id}`);
    console.log(`  status      ${row.status}  (retry_count ${row.retry_count})`);
    console.log(`  referencia  ${row.reference_type ?? "-"} / ${row.reference_id ?? "-"}`);
    console.log(`  error       ${row.error ? row.error.slice(0, 160) : "-"}`);
    console.log(
      `  depende de  ${row.depends_on ?? "(nada)"}${
        row.depends_on ? `  [${row.parent_step} · ${row.parent_status}]` : ""
      }`
    );

    // ── Precondiciones ───────────────────────────────────────────────────────
    if (!SUPPORTED_STEPS.includes(row.step as (typeof SUPPORTED_STEPS)[number])) {
      fail(
        `El existence-check sólo aplica a ${SUPPORTED_STEPS.join(" / ")}. ` +
          `Esta fila es '${row.step}': un MOD es idempotente y se reintenta directo.`
      );
    }
    if (row.status === "confirmed" || row.status === "fixed") {
      console.log(
        `\n✓ Nada que hacer: la fila ya está '${row.status}'. (no-op)`
      );
      return;
    }
    if (!REARMABLE_STATUSES.includes(row.status as (typeof REARMABLE_STATUSES)[number])) {
      fail(
        `No se re-arma una fila en '${row.status}' — puede estar en vuelo en el bridge. ` +
          `Sólo ${REARMABLE_STATUSES.join(" / ")}.`
      );
    }

    // Sin `txn_date` la consulta de existencia no tiene ventana que mirar y el
    // matcher devolvería "ausente" por falta de candidatos → ADD duplicado.
    const payload = row.payload ?? {};
    if (row.step === "vendor_bill_add" && !payload.txn_date) {
      fail(
        "El payload no tiene `txn_date`: la BillQuery de existencia se construye " +
          "con esa fecha como ventana (from=to). Sin ella el check daría 'ausente' " +
          "y el pipeline mandaría un ADD nuevo. Resolver a mano."
      );
    }
    // El matcher necesita al menos una de las dos señales para reconocer el doc.
    if (row.step === "vendor_bill_add" && !payload.memo && !payload.ref_number) {
      fail(
        "El payload no tiene ni `memo` ni `ref_number`: `matchExistingVendorBill` " +
          "no tiene con qué identificar el Bill dentro de la ventana. Resolver a mano."
      );
    }

    const parentResolved =
      !row.depends_on ||
      row.parent_status === "confirmed" ||
      row.parent_status === "fixed";
    const nextStatus = parentResolved ? "pending" : "waiting";

    console.log("\n── Qué va a pasar ──────────────────────────────────────────");
    console.log(`  1. payload.${EXISTENCE_CHECK_KEY} = true`);
    console.log(`  2. status '${row.status}' → '${nextStatus}'`);
    if (!parentResolved) {
      console.log(
        `     (queda 'waiting': su dependencia está '${row.parent_status}')`
      );
    }
    console.log(
      "  3. el consolidator consulta QuickBooks (read-only) antes de cualquier ADD:"
    );
    if (row.step === "vendor_bill_add") {
      console.log(
        `     BillQuery ventana ${String(payload.txn_date).slice(0, 10)} · ` +
          `ref '${String(payload.ref_number ?? "-")}' · memo '${String(payload.memo ?? "-")}'`
      );
    }
    console.log(
      "     · si el documento existe  → lo adopta (TxnID + líneas), SIN ADD nuevo"
    );
    console.log("     · si no existe            → despacha el ADD real");
    console.log(
      "  4. al confirmar, wake-dependents destraba la cadena que espera detrás"
    );

    const { rows: blocked } = await client.query<{ seq: number; step: string; status: string }>(
      `WITH RECURSIVE chain AS (
         SELECT id, seq, step, status FROM qb_order_pipeline WHERE depends_on = $1::uuid
         UNION ALL
         SELECT c.id, c.seq, c.step, c.status
           FROM qb_order_pipeline c JOIN chain p ON c.depends_on = p.id
       )
       SELECT seq, step, status FROM chain ORDER BY seq`,
      [rowId]
    );
    if (blocked.length > 0) {
      console.log("\n  Esperando detrás de esta fila:");
      for (const b of blocked) {
        console.log(`     #${b.seq}  ${b.step}  [${b.status}]`);
      }
    }

    if (!apply) {
      console.log("\n── DRY RUN — no se escribió nada. Repetir con --apply ──────\n");
      return;
    }

    // ── Escritura ────────────────────────────────────────────────────────────
    // Una sola transacción: la fila delegada y su espejo legacy se mueven juntas
    // o no se mueve ninguna. Un espejo desincronizado es el modo de falla que ya
    // costó las cuatro vendor bills del 2026-07-28.
    await client.query("BEGIN");
    const updated = await client.query(
      `UPDATE qb_order_pipeline
          SET status        = $2,
              payload       = COALESCE(payload, '{}'::jsonb) ||
                              jsonb_build_object($3::text, true),
              bridge_op_id  = NULL,
              submitted_at  = NULL,
              retry_count   = 0,
              error         = $4,
              next_retry_at = NULL,
              failed_at     = NULL,
              updated_at    = NOW()
        WHERE id = $1::uuid
          AND status NOT IN ('confirmed', 'fixed')`,
      [rowId, nextStatus, EXISTENCE_CHECK_KEY, REASON]
    );
    if (updated.rowCount !== 1) {
      await client.query("ROLLBACK");
      fail(
        `El UPDATE afectó ${updated.rowCount} filas — la fila cambió de estado ` +
          "mientras corría el script. Nada escrito; volver a correr el dry-run."
      );
    }

    const legacyId =
      typeof payload.qb_vendor_bill_pipeline_id === "string"
        ? payload.qb_vendor_bill_pipeline_id
        : typeof payload.qb_item_receipt_pipeline_id === "string"
          ? payload.qb_item_receipt_pipeline_id
          : null;
    if (legacyId && row.step === "vendor_bill_add") {
      await client.query(
        `UPDATE qb_vendor_bill_pipeline
            SET status = 'waiting', qb_operation_id = NULL, retries = 0,
                last_error = $2, next_retry_at = NULL, updated_at = NOW()
          WHERE id = $1 AND deleted_at IS NULL`,
        [legacyId, REASON]
      );
    } else if (legacyId && row.step === "item_receipt_add") {
      await client.query(
        `UPDATE qb_item_receipt_pipeline
            SET status = 'waiting', qb_operation_id = NULL,
                last_error = $2, next_retry_at = NULL, updated_at = NOW()
          WHERE id = $1 AND deleted_at IS NULL`,
        [legacyId, REASON]
      );
    }
    await client.query("COMMIT");

    console.log(`\n✓ Fila re-armada como '${nextStatus}' con el existence-check activo.`);
    console.log(
      "  El consolidator (cron */1) la toma en el próximo pase. Verificar con:\n" +
        `    SELECT seq, step, status, qb_txn_id, error FROM qb_order_pipeline WHERE seq >= ${row.seq} ORDER BY seq;\n`
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((e) => {
  console.error("\n✗ FALLÓ:", e instanceof Error ? e.message : e);
  process.exit(1);
});
