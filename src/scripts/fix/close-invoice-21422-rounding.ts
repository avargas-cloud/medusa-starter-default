/**
 * src/scripts/fix/close-invoice-21422-rounding.ts
 *
 * Cierra el centavo de la factura 21422 — el caso que originó todo el mecanismo
 * y el ÚNICO residuo ≤5¢ abierto en toda la base de producción.
 *
 * ── Por qué hace falta un script ──────────────────────────────────────────────
 * El write-off dispara AL APLICAR un pago. El de 21422 ya está aplicado por
 * completo (674.95 de un pago de 885.87; el resto fue a la 21402), así que no
 * queda ningún evento futuro sobre esa factura que pueda dispararlo. Se cura una
 * vez, a mano, o no se cura.
 *
 * ── Qué hace, en orden ────────────────────────────────────────────────────────
 *   1. Emite el ajuste por el camino REAL (`createRoundingWriteOff`), no con un
 *      INSERT a mano: así pasa por el tope, el motivo, la cuenta y el CHECK.
 *   2. Cierra la factura (balance 0, status paid) — lo mismo que hace la ruta de
 *      apply cuando el write-off se emite.
 *   3. Re-encola la fila de `apply_payment` para que el dispatch mande el
 *      `ReceivePaymentMod` con el `DiscountAmount` adjunto.
 *
 * ── Por qué el paso 3 es seguro, aunque el step esté excluido ─────────────────
 * `apply_payment` NO está en `IDEMPOTENT_REDISPATCH_STEPS`, y con razón: ese
 * nombre cubre DOS operaciones — un `Mod` (merge-apply, idempotente) para pagos
 * normales y un `ReceivePaymentAdd` (NO idempotente) para credit memos. Como una
 * de las ramas mintearía un documento duplicado, el step entero quedó afuera del
 * re-despacho a ciegas.
 *
 * Este pago es `type='payment'`, `qb_source` vacío → va por merge-apply, que es
 * read-merge-replace y lleva `requireTrustworthyAppliedList` (el guard que evita
 * el clobber de agosto). El script VERIFICA esa condición antes de re-encolar y
 * aborta si no se cumple: la seguridad viene del chequeo, no de mi memoria.
 *
 * ── Correr ────────────────────────────────────────────────────────────────────
 *   # mirar (no escribe):
 *   env DATABASE_URL="$(grep ^DATABASE_URL= .env|cut -d= -f2-)" \
 *     npx medusa exec ./src/scripts/fix/close-invoice-21422-rounding.ts
 *   # escribir:
 *   ROUNDING_FIX_CONFIRM=yes env DATABASE_URL="..." npx medusa exec ...
 */

import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import { getDbPool } from "../../api/utils/db-pool";
import { INVOICE_MODULE } from "../../modules/invoices";
import { loadRoundingConfig } from "../../lib/rounding/config";
import { createRoundingWriteOff } from "../../lib/rounding/create-write-off";

const INVOICE_NUMBER = "21422";
const WRITE = process.env.ROUNDING_FIX_CONFIRM === "yes";

export default async function main({ container }: { container: MedusaContainer }) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const pool = getDbPool();
  const say = (m: string) => logger.info(`[21422] ${m}`);

  say(WRITE ? "modo ESCRITURA" : "modo consulta — no se escribe nada");

  // ── 0. Precondiciones ──────────────────────────────────────────────────────
  const config = await loadRoundingConfig();
  if (!config) {
    say("ABORTA: el mecanismo está apagado (faltan cuentas en store.metadata).");
    return;
  }
  say(`cuentas OK · shortage=${config.shortageAccountListId}`);

  const { rows: invRows } = await pool.query(
    `SELECT id, invoice_number, order_id, total, amount_paid, balance_due, status
       FROM pos_invoice
      WHERE invoice_number = $1 AND voided_at IS NULL AND deleted_at IS NULL`,
    [INVOICE_NUMBER]
  );
  const inv = invRows[0];
  if (!inv) return say(`ABORTA: no existe la factura ${INVOICE_NUMBER} viva.`);
  say(
    `factura ${inv.invoice_number}: total=${inv.total} pagado=${inv.amount_paid} saldo=${inv.balance_due} (${inv.status})`
  );

  if (Number(inv.balance_due) !== 1) {
    return say(
      `ABORTA: el saldo esperado era 1¢ y hay ${inv.balance_due}¢. Alguien lo movió — revisar antes de tocar.`
    );
  }

  const { rows: existing } = await pool.query(
    `SELECT id FROM pos_rounding_adjustment
      WHERE invoice_id = $1 AND voided_at IS NULL AND deleted_at IS NULL`,
    [inv.id]
  );
  if (existing.length > 0) {
    return say(`ABORTA: ya tiene un ajuste vivo (${existing[0].id}). Nada que hacer.`);
  }

  // La condición que hace seguro el re-encolado. Se COMPRUEBA, no se recuerda.
  const { rows: payRows } = await pool.query(
    `SELECT cp.id, cp.display_id, cp.type, cp.metadata->>'qb_source' AS qb_source,
            pa.id AS application_id
       FROM payment_application pa
       JOIN customer_payment cp ON cp.id = pa.payment_id
      WHERE pa.invoice_id = $1 AND pa.voided_at IS NULL AND pa.deleted_at IS NULL`,
    [inv.id]
  );
  const pay = payRows[0];
  if (!pay) return say("ABORTA: la factura no tiene aplicación viva.");
  if (pay.type === "credit_memo" || pay.qb_source === "sales_receipt") {
    return say(
      `ABORTA: el pago es ${pay.type}/${pay.qb_source} — su dispatch es un ADD no idempotente. Re-encolar mintearía un documento.`
    );
  }
  say(`pago PAY-${pay.display_id} type=${pay.type} → rama merge-apply (idempotente) ✔`);

  const { rows: rowRows } = await pool.query(
    `SELECT id, status FROM qb_order_pipeline
      WHERE step = 'apply_payment' AND reference_id = $1
      ORDER BY created_at DESC LIMIT 1`,
    [pay.application_id]
  );
  const pipelineRow = rowRows[0];
  say(
    pipelineRow
      ? `fila de pipeline ${pipelineRow.id} (${pipelineRow.status})`
      : "sin fila de pipeline — el paso 3 se saltea"
  );

  if (!WRITE) {
    say("");
    say("QUÉ HARÍA:");
    say("  1. emitir 1 ajuste shortage de 1¢ contra Shortages");
    say(`  2. factura ${INVOICE_NUMBER} → balance 0, status paid`);
    if (pipelineRow) say(`  3. re-encolar ${pipelineRow.id} → ReceivePaymentMod con DiscountAmount 0.01`);
    say("");
    say("Para ejecutarlo: ROUNDING_FIX_CONFIRM=yes");
    return;
  }

  // ── 1. El ajuste, por el camino real ───────────────────────────────────────
  const outcome = await createRoundingWriteOff(container, {
    invoiceId: inv.id,
    invoiceNumber: inv.invoice_number,
    orderId: inv.order_id,
    balanceDueCents: Number(inv.balance_due),
    actor: "fix:close-invoice-21422",
  });
  if (!outcome.created) {
    return say(`ABORTA: no se emitió el ajuste — ${outcome.skippedReason}`);
  }
  say(`✔ ajuste ${outcome.adjustmentId} · ${outcome.amountCents}¢ · ${outcome.direction}`);

  // ── 2. Cerrar la factura ───────────────────────────────────────────────────
  const invoiceService: any = container.resolve(INVOICE_MODULE);
  await invoiceService.updatePosInvoices({
    id: inv.id,
    balance_due: 0,
    status: "paid",
  });
  const { rows: after } = await pool.query(
    `SELECT balance_due, status FROM pos_invoice WHERE id = $1`,
    [inv.id]
  );
  say(`✔ factura → saldo=${after[0].balance_due} status=${after[0].status}`);

  // ── 3. Re-encolar para que el descuento llegue a QuickBooks ────────────────
  if (pipelineRow) {
    await pool.query(
      `UPDATE qb_order_pipeline
          SET status = 'pending', error = NULL, next_retry_at = NULL, updated_at = NOW()
        WHERE id = $1`,
      [pipelineRow.id]
    );
    say(`✔ fila ${pipelineRow.id} → pending (el dispatcher la toma en ≤1 min)`);
    say("");
    say("VERIFICAR en unos minutos:");
    say(`  SELECT status, error FROM qb_order_pipeline WHERE id='${pipelineRow.id}';`);
    say(`  SELECT qb_status, qb_error FROM pos_rounding_adjustment WHERE id='${outcome.adjustmentId}';`);
    say("  y en QuickBooks: el ReceivePayment 1CCA97-1786389056 con 0.01 de descuento");
  }
}
