import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { z } from "zod";
import { ulid } from "ulid";
import { loadCreditMemoMovements } from "../../../_lib/load-cm-movements";

type Knex = { raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: any[] }> };

const BUCKETS = ["china_cogs", "local_cogs", "operating", "reserve"] as const;

const bodySchema = z.object({
  payment_application_id: z.string().min(1),
  action: z.enum(["keep", "move"]),
  target_bucket: z.enum(BUCKETS).optional(),
  derivation_hash: z.string().min(1),
  reason: z.string().max(2000).optional(),
});

/**
 * POST /admin/accounting/treasury/daily/cm-movement/resolve
 *
 * Records the accountant's bucket assignment for ONE credit-memo redemption
 * (see load-cm-movements.ts). Body:
 *   { payment_application_id, action: 'keep'|'move', target_bucket?, derivation_hash, reason? }
 *
 * - 'keep' → the credit's cash stays in its current bucket (stored as
 *   resolution 'kept'; only valid when the backing is a pure category).
 * - 'move' → manual inter-bank transfer of the credit's FACE VALUE from the
 *   current bucket to `target_bucket` (stored as 'moved'). The accountant
 *   executes the transfer at the bank — this is advisory + audit, it never
 *   feeds the split math. Backing/consumption/suggested COGS math is kept in
 *   movement_json as audit context.
 * - Mixed/unknown backing has no "keep" shortcut: action must be 'move' and a
 *   reason is required (the accountant is deciding where an ambiguous credit
 *   sits — that judgment call needs a note).
 *
 * Guards (money-safety):
 *  1. Recomputes the movement LIVE and rejects 409 STALE_DERIVATION if the
 *     client's hash no longer matches — the accountant must re-see the current
 *     numbers before deciding.
 *  2. Rejects 409 if that redemption's day is already Confirmed & Locked (its
 *     movements are frozen in the snapshot; resolving after lock is a no-op
 *     that would desync the audit trail).
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
    // Resolve the redemption's day (movements are dated by applied_at).
    const dayRes = await knex.raw(
      `SELECT (applied_at AT TIME ZONE 'America/New_York')::date::text AS day
       FROM payment_application WHERE id = ? AND voided_at IS NULL AND deleted_at IS NULL`,
      [body.payment_application_id]
    );
    const day = dayRes.rows?.[0]?.day as string | undefined;
    if (!day) {
      return res.status(404).json({
        success: false,
        error: "payment_application not found (or voided)",
      });
    }

    // Guard 2: refuse to resolve into a locked day.
    const locked = await knex.raw(
      `SELECT 1 FROM treasury_distribution_log
       WHERE distribution_date = ?::date AND executed_at IS NOT NULL LIMIT 1`,
      [day]
    );
    if ((locked.rows?.length ?? 0) > 0) {
      return res.status(409).json({
        success: false,
        error: `That day (${day}) is already Confirmed & Locked — its movements are frozen. Resolve on an open day.`,
      });
    }

    // Guard 1: recompute live and validate.
    const movements = await loadCreditMemoMovements(
      knex,
      `${day} 00:00:00`,
      `${day} 23:59:59.999999`
    );
    const live = movements.find(
      (m) => m.payment_application_id === body.payment_application_id
    );
    if (!live) {
      return res.status(409).json({
        success: false,
        error:
          "This redemption no longer needs a movement decision (its numbers changed). Reload the report.",
      });
    }
    if (live.derivation_hash !== body.derivation_hash) {
      return res.status(409).json({
        success: false,
        error: "STALE_DERIVATION",
        data: { current: live },
      });
    }

    const currentIsPure =
      live.current_bucket === "china_cogs" || live.current_bucket === "local_cogs";

    if (body.action === "keep") {
      if (!currentIsPure) {
        return res.status(409).json({
          success: false,
          error:
            "This credit's backing is mixed/unknown — there is no single current bucket to keep. Pick a bucket explicitly (with a reason).",
        });
      }
    } else {
      if (!body.target_bucket) {
        return res.status(400).json({
          success: false,
          error: "target_bucket is required for action 'move'",
        });
      }
      if (currentIsPure && body.target_bucket === live.current_bucket) {
        return res.status(400).json({
          success: false,
          error: "target_bucket equals the current bucket — use action 'keep' instead",
        });
      }
      if (!currentIsPure && !(body.reason && body.reason.trim().length > 0)) {
        return res.status(400).json({
          success: false,
          error:
            "reason is required when assigning a bucket to a mixed/unknown-backing credit",
        });
      }
    }

    const resolution = body.action === "keep" ? "kept" : "moved";
    const targetBucket =
      body.action === "keep"
        ? (live.current_bucket as (typeof BUCKETS)[number])
        : body.target_bucket!;
    const amountCents = live.amount_applied_cents;

    const movementJson = JSON.stringify({
      current_bucket: live.current_bucket,
      target_bucket: targetBucket,
      face_value_cents: amountCents,
      // COGS-engine audit context (NOT the moved amount):
      suggested_movement: live.suggested_movement,
      backing: live.backing,
      consumption: live.consumption,
      surplus_shortfall_cents: live.surplus_shortfall_cents,
      backing_status: live.backing_status,
    });

    const id = `tcmr_${ulid()}`;
    await knex.raw(
      `INSERT INTO treasury_cm_movement_resolution
         (id, payment_application_id, resolution, derivation_hash, movement_json,
          reason, current_bucket, target_bucket, amount_cents,
          resolved_by_user_id, resolved_at)
       VALUES (?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?, now())
       ON CONFLICT (payment_application_id) DO UPDATE SET
         resolution = EXCLUDED.resolution,
         derivation_hash = EXCLUDED.derivation_hash,
         movement_json = EXCLUDED.movement_json,
         reason = EXCLUDED.reason,
         current_bucket = EXCLUDED.current_bucket,
         target_bucket = EXCLUDED.target_bucket,
         amount_cents = EXCLUDED.amount_cents,
         resolved_by_user_id = EXCLUDED.resolved_by_user_id,
         resolved_at = now()`,
      [
        id,
        body.payment_application_id,
        resolution,
        body.derivation_hash,
        movementJson,
        body.reason?.trim() || null,
        live.current_bucket,
        targetBucket,
        amountCents,
        actorId,
      ]
    );

    return res.json({
      success: true,
      data: {
        payment_application_id: body.payment_application_id,
        resolution,
        target_bucket: targetBucket,
        amount_cents: amountCents,
      },
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to resolve movement";
    return res.status(500).json({ success: false, error: message });
  }
}
