import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { z } from "zod";
import { ulid } from "ulid";
import { loadDailyReport } from "../../_lib/load-daily-report";

type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
  transaction?: () => Promise<
    Knex & { commit: () => Promise<void>; rollback: () => Promise<void> }
  >;
};

const confirmSchema = z.object({
  action: z.literal("confirm"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  notes: z.string().max(2000).optional(),
});

/**
 * POST /admin/accounting/treasury/daily/log
 *
 * { action: "confirm", date, notes? } — "Confirm Transfers": the accounts
 * manager clicks this once they've actually executed that day's wires in
 * each bank portal. This is the ONLY action on this route (replaces the old
 * two-step snapshot/mark_executed flow, which was never used in prod).
 *
 * Atomically, inside a transaction with an advisory lock on the date:
 *  1. Refuses 409 if the date is already confirmed (belt-and-suspenders with
 *     the DB's UNIQUE(distribution_date) constraint).
 *  2. Recomputes the day FRESH (never trusts a client-supplied report — data
 *     may have changed since the page loaded).
 *  3. Refuses 500 if the reconciliation invariant is broken (delta_cents != 0).
 *  4. Refuses 409 if any payment still counts as unattributed for this day —
 *     link it to its order/invoice, or use "Exception — defer to next day"
 *     on it first (see ../defer-payment/route.ts).
 *  5. Inserts ONE already-executed row. From this point on, every GET for
 *     this date returns this exact frozen snapshot forever — see
 *     ../../_lib/load-daily-report.ts.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const parsed = confirmSchema.safeParse(req.body);
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
    (req as any).auth_context?.actor_id ??
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req as any).user?.id ??
    null;

  const trx = knex.transaction ? await knex.transaction() : null;
  const db = trx ?? knex;

  try {
    await db.raw(`SELECT pg_advisory_xact_lock(hashtext('treasury_confirm:' || ?))`, [
      body.date,
    ]);

    const already = (await db.raw(
      `SELECT id FROM treasury_distribution_log
       WHERE distribution_date = ?::date AND executed_at IS NOT NULL`,
      [body.date]
    )) as { rows: unknown[] };
    if (already.rows.length > 0) {
      if (trx) await trx.rollback();
      return res.status(409).json({
        success: false,
        error: "This day is already confirmed and locked.",
      });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await loadDailyReport(db as any, body.date, body.date);

    if (report.reconciliation.delta_cents !== 0) {
      if (trx) await trx.rollback();
      return res.status(500).json({
        success: false,
        error: "Refusing to confirm a report with non-zero reconciliation delta",
        data: report,
      });
    }

    if (report.unattributed_payments.length > 0) {
      if (trx) await trx.rollback();
      const totalUnapplied = report.unattributed_payments.reduce(
        (sum, p) => sum + p.unapplied_cents,
        0
      );
      return res.status(409).json({
        success: false,
        error: `UNATTRIBUTED_PAYMENTS_BLOCK: ${report.unattributed_payments.length} payment(s) totaling $${(
          totalUnapplied / 100
        ).toFixed(
          2
        )} are not linked to an order/invoice yet. Link them, or use "Exception — defer to next day" on each, before confirming.`,
        data: { unattributed_payments: report.unattributed_payments },
      });
    }

    const id = `tdl_${ulid()}`;
    const executedAt = new Date().toISOString();
    await db.raw(
      `INSERT INTO treasury_distribution_log
         (id, distribution_date, generated_by_user_id, snapshot_json,
          executed_at, executed_by_user_id, notes)
       VALUES (?, ?, ?, ?::jsonb, now(), ?, ?)`,
      [id, body.date, actorId, JSON.stringify(report), actorId, body.notes ?? null]
    );

    if (trx) await trx.commit();

    return res.json({
      success: true,
      data: {
        id,
        distribution_date: body.date,
        executed_at: executedAt,
        executed_by_user_id: actorId,
        report,
      },
    });
  } catch (err) {
    if (trx) await trx.rollback();
    const message =
      err instanceof Error ? err.message : "Failed to confirm treasury day";
    return res.status(500).json({ success: false, error: message });
  }
}
