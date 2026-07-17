import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { z } from "zod";
import { ulid } from "ulid";
import { loadCreditMemoMovements } from "../../../_lib/load-cm-movements";

type Knex = { raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: any[] }> };

const bodySchema = z
  .object({
    payment_application_id: z.string().min(1),
    resolution: z.enum(["confirmed", "ignored", "unattributable"]),
    derivation_hash: z.string().min(1),
    reason: z.string().max(2000).optional(),
  })
  .refine(
    (b) => b.resolution === "confirmed" || (b.reason && b.reason.trim().length > 0),
    { message: "reason is required for ignored / unattributable", path: ["reason"] }
  );

/**
 * POST /admin/accounting/treasury/daily/cm-movement/resolve
 *
 * Records an accountant's decision on ONE credit-memo cross-category COGS
 * movement (see load-cm-movements.ts). Body:
 *   { payment_application_id, resolution, derivation_hash, reason? }
 *
 * - 'confirmed'      → apply the china↔local bank rebalance (audited).
 * - 'ignored'        → acknowledged, no movement (reason required).
 * - 'unattributable' → backing can't be determined (reason required).
 *
 * Guards (money-safety):
 *  1. Recomputes the movement LIVE and rejects 409 STALE_DERIVATION if the
 *     client's hash no longer matches — the accountant must re-see the current
 *     numbers before deciding.
 *  2. Rejects 409 if that redemption's day is already Confirmed & Locked (its
 *     movements are frozen in the snapshot; resolving after lock is a no-op
 *     that would desync the audit trail).
 *  3. 'confirmed' is only valid when the live derivation actually suggests a
 *     movement (cash_backed cross-category) — you can't "confirm" a non-movement.
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
      `SELECT applied_at::date::text AS day
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

    // Guard 1 + 3: recompute live and validate.
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
    if (body.resolution === "confirmed" && live.suggested_movement === null) {
      return res.status(409).json({
        success: false,
        error:
          "Nothing to confirm — this row has no suggested movement (mark it ignored or unattributable instead).",
      });
    }

    const movementJson = JSON.stringify({
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
          reason, resolved_by_user_id, resolved_at)
       VALUES (?, ?, ?, ?, ?::jsonb, ?, ?, now())
       ON CONFLICT (payment_application_id) DO UPDATE SET
         resolution = EXCLUDED.resolution,
         derivation_hash = EXCLUDED.derivation_hash,
         movement_json = EXCLUDED.movement_json,
         reason = EXCLUDED.reason,
         resolved_by_user_id = EXCLUDED.resolved_by_user_id,
         resolved_at = now()`,
      [
        id,
        body.payment_application_id,
        body.resolution,
        body.derivation_hash,
        movementJson,
        body.reason ?? null,
        actorId,
      ]
    );

    return res.json({
      success: true,
      data: { payment_application_id: body.payment_application_id, resolution: body.resolution },
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to resolve movement";
    return res.status(500).json({ success: false, error: message });
  }
}
