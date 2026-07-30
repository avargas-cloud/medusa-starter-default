import { randomBytes } from "crypto";

import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getDbPool } from "../../../../utils/db-pool";
import {
  extractSupervisorPin,
  guardSupervisorPin,
  pinGuardResponse,
  resolveActorId,
} from "../../../../../lib/pos/supervisor-pin-guard";
import { pgAsPinConn } from "../../../../../lib/pos/verify-supervisor-pin";

/**
 * POST /admin/customer-payments/:id/transfer
 *
 * Reassigns an UNAPPLIED payment to a different customer (fixes a mis-assigned
 * payment). Hard-guarded: only POS payments with zero active applications can be
 * transferred. The actor is taken from the auth context (never trusted from the
 * body) and the supervisor PIN is validated server-side.
 *
 * If the payment is already synced to QB, a `transfer_payment` pipeline step is
 * enqueued to delete the old ReceivePayment and recreate it under the new
 * customer. If it never synced, changing customer_id is enough (the create
 * handler resolves the QB customer fresh at sync time).
 */
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const paymentId = req.params.id as string;
  // `supervisor_pin` ya no se destructura: lo extrae el guard, que mira tambien
  // el header `x-supervisor-pin`.
  const { target_customer_id, reason } = (req.body ?? {}) as {
    target_customer_id?: string;
    reason?: string;
  };

  const logger = req.scope.resolve("logger");
  const pool = getDbPool();

  // Actor from auth context — do NOT trust a body field.
  const actorId =
    (req.auth_context as { actor_id?: string } | undefined)?.actor_id ?? null;
  if (!actorId) {
    return res.status(401).json({ error: "Unauthenticated" });
  }

  if (!target_customer_id) {
    return res.status(400).json({ error: "target_customer_id is required" });
  }

  // PIN de supervisor por el guard COMPARTIDO.
  //
  // Antes esta ruta copiaba la comparación a mano — verificaba de verdad, pero
  // sin límite de intentos. Eso alcanzaba mientras el PIN viajara al navegador
  // (para probarlo había que conocerlo). Ahora que el valor no viaja, la fuerza
  // bruta es el ataque que queda: 4 dígitos son 10.000 combinaciones y un
  // script las prueba en segundos. El guard cuenta los fallos por usuario.
  //
  // El adaptador existe porque acá hay un pg pool y el helper pide una conexión
  // estilo knex — pero su query no lleva parámetros, así que la advertencia
  // sobre no mezclar estilos de binding no aplica.
  {
    const guard = await guardSupervisorPin({
      scope: req.scope as unknown as { resolve: (k: string) => unknown },
      db: pgAsPinConn(pool),
      pin: extractSupervisorPin(req),
      actorId: resolveActorId(req),
    });
    if (!guard.ok) {
      const { status, body } = pinGuardResponse(guard);
      return res.status(status).json(body);
    }
  }

  const client = await pool.connect();
  let qbOldTxnId: string | null = null;
  let needsQbTransfer = false;
  let transferId: string | null = null;
  let dependsOn: string | null = null;
  let coalesced = false;
  try {
    await client.query("BEGIN");

    // Lock the payment row and re-check every guard inside the transaction.
    const { rows: pRows } = await client.query(
      `SELECT id, customer_id, source, type, status, amount, locked_order_id, metadata
         FROM customer_payment WHERE id = $1 FOR UPDATE`,
      [paymentId]
    );
    const payment = pRows[0];
    if (!payment) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Payment not found" });
    }

    if (payment.type !== "payment") {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "Only payments can be transferred (not refunds or credit memos)",
      });
    }
    if (payment.source !== "pos" || payment.locked_order_id) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error:
          "Only standalone POS payments can be transferred. Web/order-locked payments are not supported.",
      });
    }
    if (["voided", "refunded", "partial_refunded"].includes(payment.status)) {
      await client.query("ROLLBACK");
      return res
        .status(409)
        .json({ error: `Cannot transfer a ${payment.status} payment` });
    }
    if (payment.customer_id === target_customer_id) {
      await client.query("ROLLBACK");
      return res
        .status(409)
        .json({ error: "Payment is already assigned to that customer" });
    }

    // Primary guard: zero ACTIVE applications (invoice-bound OR order-only).
    const { rows: appRows } = await client.query(
      `SELECT id, invoice_id, invoice_number, order_id, amount_applied
         FROM payment_application
        WHERE payment_id = $1 AND voided_at IS NULL`,
      [paymentId]
    );
    if (appRows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "PAYMENT_HAS_ACTIVE_APPLICATIONS",
        message:
          "This payment is applied. Unapply it from the listed invoices/orders before transferring.",
        applications: appRows.map((a) => ({
          id: a.id,
          invoice_id: a.invoice_id,
          invoice_number: a.invoice_number,
          order_id: a.order_id,
          amount_applied: Number(a.amount_applied),
        })),
      });
    }

    // Target customer must exist.
    const { rows: cRows } = await client.query(
      `SELECT id FROM customer WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
      [target_customer_id]
    );
    if (cRows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Target customer not found" });
    }

    const fromCustomerId: string = payment.customer_id;
    const amountCents = Math.round(Number(payment.amount));
    qbOldTxnId = (payment.metadata?.qb_txn_id as string | undefined) ?? null;
    const qbSyncStatus = (payment.metadata?.qb_sync_status as string) ?? "";
    needsQbTransfer =
      process.env.QB_ORDER_FLOW_ENABLED === "true" && !!qbOldTxnId;

    // Block while a NON-transfer QB op is mid-flight on this payment (the original
    // create / an apply / a void). Transfers themselves no longer set
    // qb_sync_status, so this never blocks transfer chaining below.
    if (
      process.env.QB_ORDER_FLOW_ENABLED === "true" &&
      ["submitted", "processing", "creating", "voiding"].includes(qbSyncStatus)
    ) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "QB sync in progress for this payment — try again shortly",
      });
    }

    // CHAIN transfers per payment. If a prior transfer_payment row is still
    // unresolved, the new one depends_on it (status 'waiting') so the QB
    // delete+recreate runs strictly AFTER the prior link. The handler resolves the
    // current txn LIVE, so each link operates on the txn the previous link created
    // (A→B then B→C ends at C with no divergence). The FOR UPDATE lock serializes
    // concurrent requests, so the prior row is always visible here. A prior FAILED
    // transfer is a dead link (it would wait forever) — block until an operator
    // resolves it rather than chaining onto it.
    let latest:
      | { id: string; status: string; transfer_id: string | null }
      | undefined;
    // Inspect prior transfer_payment rows whenever QB is enabled — even if THIS
    // payment currently has no qb_txn_id — so a stale failed/in-flight transfer is
    // never ignored just because needsQbTransfer is false this time.
    if (process.env.QB_ORDER_FLOW_ENABLED === "true") {
      const { rows: unresolved } = await client.query(
        `SELECT id, status, payload->>'transfer_id' AS transfer_id
           FROM qb_order_pipeline
          WHERE reference_id = $1 AND step = 'transfer_payment'
            AND status NOT IN ('confirmed', 'cancelled', 'skipped')
          ORDER BY created_at DESC`,
        [paymentId]
      );
      // Any failed link means the chain is stuck (dependents wait forever) — block
      // until an operator resolves it rather than extending a dead chain.
      if (unresolved.some((r) => r.status === "failed")) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: "PRIOR_TRANSFER_FAILED",
          message:
            "A previous transfer for this payment failed in QuickBooks and needs review before another can be queued.",
        });
      }
      latest = unresolved[0];
    }

    // Reassign the payment — Medusa side is immediate; QB follows via the pipeline.
    await client.query(
      `UPDATE customer_payment SET customer_id = $2, updated_at = NOW() WHERE id = $1`,
      [paymentId, target_customer_id]
    );

    transferId = `cptr_${cryptoRandomId()}`;
    await client.query(
      `INSERT INTO customer_payment_transfer
         (id, payment_id, from_customer_id, to_customer_id, amount, raw_amount,
          reason, requested_by, qb_old_txn_id, qb_status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,NOW(),NOW())`,
      [
        transferId,
        paymentId,
        fromCustomerId,
        target_customer_id,
        amountCents,
        JSON.stringify({ value: String(amountCents), precision: 20 }),
        reason ?? null,
        actorId,
        qbOldTxnId,
        needsQbTransfer || latest ? "pending" : "not_synced",
      ]
    );

    // Enqueue the QB transfer INSIDE the txn so the lock serializes everything.
    // COALESCE: if the most-recent unresolved link hasn't STARTED yet (still
    // 'pending' or 'waiting'), retarget THAT row to the new customer instead of
    // adding another — rapid corrections (A→B→C→D) collapse to "doing A, waiting D"
    // (B, C superseded), never a growing chain of waiting rows. The conditional
    // WHERE status IN ('pending','waiting') makes the retarget atomic vs the
    // consolidator claiming a 'pending' row mid-request (→ falls back to chaining).
    // No old_txn_id in the payload — the handler resolves the current txn live.
    // Run whenever a prior unresolved link exists (`latest`) even if THIS payment
    // momentarily has no qb_txn_id, so the existing link is retargeted rather than
    // left pointing at the old customer.
    if (needsQbTransfer || latest) {
      if (latest && (latest.status === "pending" || latest.status === "waiting")) {
        const { rows: did } = await client.query(
          `UPDATE qb_order_pipeline
              SET payload = jsonb_set(
                    jsonb_set(COALESCE(payload, '{}'::jsonb), '{target_customer_id}', to_jsonb($2::text)),
                    '{transfer_id}', to_jsonb($3::text)),
                  updated_at = NOW()
            WHERE id = $1 AND status IN ('pending', 'waiting')
            RETURNING id`,
          [latest.id, target_customer_id, transferId]
        );
        if (did.length > 0) {
          coalesced = true;
          // The audit row the link previously pointed at is now superseded.
          if (latest.transfer_id) {
            await client.query(
              `UPDATE customer_payment_transfer
                  SET qb_status = 'superseded', updated_at = NOW()
                WHERE id = $1 AND qb_status = 'pending'`,
              [latest.transfer_id]
            );
          }
        } else {
          // Lost the race — the link was just claimed → chain after it instead.
          dependsOn = latest.id;
        }
      } else if (latest) {
        // Head is already running ('processing'/'submitted') — chain a waiting tail.
        dependsOn = latest.id;
      }

      if (!coalesced) {
        await client.query(
          `INSERT INTO qb_order_pipeline
             (reference_id, reference_type, step, status, depends_on, payload, retry_count)
           VALUES ($1, 'customer_payment', 'transfer_payment', $2, $3, $4::jsonb, 0)`,
          [
            paymentId,
            dependsOn ? "waiting" : "pending",
            dependsOn,
            JSON.stringify({
              target_customer_id,
              transfer_id: transferId,
              payment_id: paymentId,
            }),
          ]
        );
      }
    }

    await client.query("COMMIT");
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => {});
    logger.error(`[transfer-payment] ❌ ${err?.message ?? err}`);
    return res.status(500).json({ error: err?.message ?? "Transfer failed" });
  } finally {
    client.release();
  }

  return res.json({
    success: true,
    payment_id: paymentId,
    target_customer_id,
    qb_transfer_enqueued: needsQbTransfer,
    // coalesced: retargeted a not-yet-started link. chained: queued behind a
    // still-running prior transfer. Neither: this is the head of a fresh transfer.
    coalesced,
    chained: needsQbTransfer && !coalesced && !!dependsOn,
  });
}

function cryptoRandomId(): string {
  // 26-char base32-ish id; uniqueness is all the audit table needs.
  const chars = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = randomBytes(26);
  let out = "";
  for (let i = 0; i < 26; i++) out += chars.charAt((bytes[i] ?? 0) % 32);
  return out;
}
