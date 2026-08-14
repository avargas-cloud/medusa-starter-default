import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { z } from "zod";
import { ulid } from "ulid";

const bodySchema = z.object({
  payment_id: z.string().min(1),
  reason: z.string().max(2000).optional(),
});

interface DeferRow {
  id: string;
  deferred_from_date: string;
  effective_treasury_date: string;
  unapplied_cents_at_deferral: string | number;
}

/**
 * POST /admin/accounting/treasury/daily/defer-payment
 *
 * "Exception — defer to next day": lets the accounts manager push a still
 * unlinked payment's cash to the following treasury day instead of linking
 * it, so today's "Confirm Transfers" isn't blocked forever. This ONLY moves
 * the UNAPPLIED remainder for Treasury's own day-bucketing purposes — it
 * never touches customer_payment.received_at/batch_day (the unrelated QB
 * TxnDate mechanism keeps reading the real capture date).
 *
 * Append-only: if the payment is still unlinked the next day, clicking this
 * again pushes it one more day and leaves a full audit trail (see
 * load-unattributed-payments.ts / treasury_payment_defer migration).
 *
 * The INSERT re-verifies (atomically, in its own WHERE) that the payment is
 * still genuinely unattributed at the moment it runs — a 0-row result means
 * someone linked it (or voided it) in the meantime, not a server error.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid body",
    });
  }
  const body = parsed.data;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pg = req.scope.resolve("__pg_connection__") as any;
  const actorId =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req as any).auth_context?.actor_id ??
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req as any).user?.id ??
    null;

  try {
    // Guard: deferring only makes sense on a day that isn't confirmed yet
    // (the whole point is to unblock "Confirm Transfers"). A day can carry a
    // non-empty unattributed list AND already be locked if it was grandfathered
    // by the historical backfill (which intentionally skips this gate) — in
    // that case there's nothing left to unblock, and silently letting the
    // defer proceed would push the payment's cash onto the NEXT day, which is
    // typically ALSO already-backfilled/locked — permanently dropping that
    // cash out of every confirmed total with no error. Block both ends.
    const lockCheck = await pg.raw(
      `SELECT
         src_locked.distribution_date IS NOT NULL AS source_locked,
         dst_locked.distribution_date IS NOT NULL AS destination_locked,
         COALESCE(l.effective_treasury_date, cp.received_at::date)::text AS source_date,
         (COALESCE(l.effective_treasury_date, cp.received_at::date) + INTERVAL '1 day')::text AS destination_date
       FROM customer_payment cp
       LEFT JOIN LATERAL (
         SELECT effective_treasury_date
         FROM treasury_payment_defer
         WHERE payment_id = cp.id
         ORDER BY created_at DESC
         LIMIT 1
       ) l ON TRUE
       LEFT JOIN treasury_distribution_log src_locked
         ON src_locked.distribution_date = COALESCE(l.effective_treasury_date, cp.received_at::date)
        AND src_locked.executed_at IS NOT NULL
       LEFT JOIN treasury_distribution_log dst_locked
         ON dst_locked.distribution_date = COALESCE(l.effective_treasury_date, cp.received_at::date) + INTERVAL '1 day'
        AND dst_locked.executed_at IS NOT NULL
       WHERE cp.id = ? AND cp.deleted_at IS NULL AND cp.type = 'payment' AND COALESCE(cp.metadata->>'is_commission_credit', '') <> 'true'`,
      [body.payment_id]
    );
    const lockInfo = lockCheck.rows?.[0];
    if (lockInfo?.source_locked) {
      return res.status(409).json({
        success: false,
        error: `This payment's current treasury day (${lockInfo.source_date}) is already confirmed — there's nothing to unblock. Link the payment to an order instead.`,
      });
    }
    if (lockInfo?.destination_locked) {
      return res.status(409).json({
        success: false,
        error: `Can't defer — the next treasury day (${lockInfo.destination_date}) is already confirmed, so this payment's cash would be dropped from every confirmed total. Link the payment to an order instead.`,
      });
    }

    const id = `tpd_${ulid()}`;
    const result = await pg.raw(
      `INSERT INTO treasury_payment_defer
         (id, payment_id, deferred_from_date, effective_treasury_date,
          unapplied_cents_at_deferral, reason, created_by_user_id)
       SELECT
         ?,
         cp.id,
         COALESCE(l.effective_treasury_date, cp.received_at::date),
         COALESCE(l.effective_treasury_date, cp.received_at::date) + INTERVAL '1 day',
         GREATEST(cp.amount - COALESCE(a.applied, 0), 0),
         ?,
         ?
       FROM customer_payment cp
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(amount_applied), 0)::numeric AS applied
         FROM payment_application
         WHERE payment_id = cp.id AND voided_at IS NULL AND deleted_at IS NULL
       ) a ON TRUE
       LEFT JOIN LATERAL (
         SELECT effective_treasury_date
         FROM treasury_payment_defer
         WHERE payment_id = cp.id
         ORDER BY created_at DESC
         LIMIT 1
       ) l ON TRUE
       LEFT JOIN treasury_distribution_log src_locked
         ON src_locked.distribution_date = COALESCE(l.effective_treasury_date, cp.received_at::date)
        AND src_locked.executed_at IS NOT NULL
       LEFT JOIN treasury_distribution_log dst_locked
         ON dst_locked.distribution_date = COALESCE(l.effective_treasury_date, cp.received_at::date) + INTERVAL '1 day'
        AND dst_locked.executed_at IS NOT NULL
       WHERE cp.id = ?
         AND cp.deleted_at IS NULL
         AND cp.type = 'payment' AND COALESCE(cp.metadata->>'is_commission_credit', '') <> 'true'
         AND cp.status <> 'voided'
         AND (cp.amount - COALESCE(a.applied, 0)) > 0
         AND src_locked.distribution_date IS NULL
         AND dst_locked.distribution_date IS NULL
       RETURNING id, deferred_from_date::text AS deferred_from_date,
                 effective_treasury_date::text AS effective_treasury_date,
                 unapplied_cents_at_deferral`,
      [id, body.reason ?? null, actorId, body.payment_id]
    );

    const rows: DeferRow[] = result.rows ?? [];
    if (rows.length === 0) {
      // Disambiguate why nothing was inserted for a clearer error message.
      const check = await pg.raw(
        `SELECT
           cp.id IS NOT NULL AS exists,
           cp.status = 'voided' AS voided,
           (cp.amount - COALESCE(a.applied, 0)) <= 0 AS fully_linked
         FROM customer_payment cp
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(amount_applied), 0)::numeric AS applied
           FROM payment_application
           WHERE payment_id = cp.id AND voided_at IS NULL AND deleted_at IS NULL
         ) a ON TRUE
         WHERE cp.id = ? AND cp.deleted_at IS NULL AND cp.type = 'payment' AND COALESCE(cp.metadata->>'is_commission_credit', '') <> 'true'`,
        [body.payment_id]
      );
      const info = check.rows?.[0];
      if (!info) {
        return res.status(404).json({ success: false, error: "Payment not found." });
      }
      if (info.voided) {
        return res.status(409).json({ success: false, error: "Payment is voided." });
      }
      if (info.fully_linked) {
        return res.status(409).json({
          success: false,
          error: "This payment is already fully linked to an order/invoice — nothing to defer.",
        });
      }
      return res.status(409).json({ success: false, error: "Unable to defer this payment." });
    }

    const row = rows[0]!;
    return res.json({
      success: true,
      data: {
        id: row.id,
        payment_id: body.payment_id,
        deferred_from_date: row.deferred_from_date,
        effective_treasury_date: row.effective_treasury_date,
        unapplied_cents_at_deferral:
          typeof row.unapplied_cents_at_deferral === "string"
            ? parseInt(row.unapplied_cents_at_deferral, 10)
            : row.unapplied_cents_at_deferral,
      },
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to defer payment";
    return res.status(500).json({ success: false, error: message });
  }
}
