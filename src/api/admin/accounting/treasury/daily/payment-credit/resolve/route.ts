import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { z } from "zod";
import { ulid } from "ulid";
import { loadUnattributedPayments } from "../../../_lib/load-unattributed-payments";

type Knex = { raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: any[] }> };

const BUCKETS = ["china_cogs", "local_cogs", "operating", "reserve"] as const;

const bodySchema = z.object({
  payment_id: z.string().min(1),
  bucket: z.enum(BUCKETS),
  /** The remainder the accountant is looking at — rejected 409 if it drifted. */
  amount_cents: z.number().int().positive(),
  reason: z.string().max(2000).optional(),
});

/**
 * POST /admin/accounting/treasury/daily/payment-credit/resolve
 *
 * "Treat as credit memo": the accountant declares an unlinked payment
 * remainder to be customer credit (not an unattributed sale) and assigns the
 * bucket its cash sits in. Unattributed cash factually lands in `operating`
 * (compute-splits sink), so `operating` = "keep"; any other bucket is a
 * manual bank transfer the accountant executes themselves — advisory + audit,
 * never feeds the split math. A valid resolution stops the payment from
 * blocking Confirm Transfers (see load-unattributed-payments.ts `blocking`);
 * if the live remainder later drifts from `amount_cents` the resolution goes
 * stale and re-blocks.
 *
 * Guards:
 *  1. 404 if the payment doesn't exist / isn't an unattributed candidate.
 *  2. 409 if the payment's effective treasury day is already Confirmed & Locked.
 *  3. 409 AMOUNT_DRIFTED if the live unapplied remainder ≠ body.amount_cents
 *     (someone linked/refunded part of it since the page loaded).
 *
 * Re-resolving UPSERTs (one active resolution per payment).
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

  const knex = (
    req.scope as unknown as { resolve: (k: string) => unknown }
  ).resolve("__pg_connection__") as Knex;
  const actorId =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req as any).auth_context?.actor_id ?? (req as any).user?.id ?? null;

  try {
    // The payment's effective treasury day (defer-aware — same COALESCE as the
    // loader), used for the locked-day guard and the live recompute window.
    const dayRes = await knex.raw(
      `SELECT COALESCE(
         (SELECT ld.effective_treasury_date FROM treasury_payment_defer ld
           WHERE ld.payment_id = cp.id ORDER BY ld.created_at DESC LIMIT 1),
         cp.received_at::date
       )::text AS day
       FROM customer_payment cp
       WHERE cp.id = ? AND cp.deleted_at IS NULL AND cp.type = 'payment'
         AND cp.status <> 'voided'`,
      [body.payment_id]
    );
    const day = dayRes.rows?.[0]?.day as string | undefined;
    if (!day) {
      return res.status(404).json({
        success: false,
        error: "payment not found (or voided / not a payment)",
      });
    }

    const locked = await knex.raw(
      `SELECT 1 FROM treasury_distribution_log
       WHERE distribution_date = ?::date AND executed_at IS NOT NULL LIMIT 1`,
      [day]
    );
    if ((locked.rows?.length ?? 0) > 0) {
      return res.status(409).json({
        success: false,
        error: `That day (${day}) is already Confirmed & Locked — nothing left to resolve.`,
      });
    }

    // Live recompute via the SAME loader the panel/gate uses — one source of
    // truth for what "the remainder" is (refund-netted, defer-aware).
    const rows = await loadUnattributedPayments(
      knex,
      `${day} 00:00:00`,
      `${day} 23:59:59.999999`
    );
    const live = rows.find((r) => r.payment_id === body.payment_id);
    if (!live) {
      return res.status(409).json({
        success: false,
        error:
          "This payment no longer has an unlinked remainder (someone linked or refunded it). Reload the report.",
      });
    }
    if (live.unapplied_cents !== body.amount_cents) {
      return res.status(409).json({
        success: false,
        error: "AMOUNT_DRIFTED",
        data: { current: live },
      });
    }

    const id = `tpcr_${ulid()}`;
    await knex.raw(
      `INSERT INTO treasury_payment_credit_resolution
         (id, payment_id, bucket, amount_cents, reason, resolved_by_user_id, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, now())
       ON CONFLICT (payment_id) DO UPDATE SET
         bucket = EXCLUDED.bucket,
         amount_cents = EXCLUDED.amount_cents,
         reason = EXCLUDED.reason,
         resolved_by_user_id = EXCLUDED.resolved_by_user_id,
         resolved_at = now()`,
      [
        id,
        body.payment_id,
        body.bucket,
        body.amount_cents,
        body.reason?.trim() || null,
        actorId,
      ]
    );

    return res.json({
      success: true,
      data: {
        payment_id: body.payment_id,
        bucket: body.bucket,
        amount_cents: body.amount_cents,
      },
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to resolve payment credit";
    return res.status(500).json({ success: false, error: message });
  }
}
