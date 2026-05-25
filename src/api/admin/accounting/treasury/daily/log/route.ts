import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { z } from "zod";
import { ulid } from "ulid";
import { loadDailyReport } from "../../_lib/load-daily-report";

const snapshotSchema = z.object({
  action: z.literal("snapshot"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  notes: z.string().max(2000).optional(),
});

const executeSchema = z.object({
  action: z.literal("mark_executed"),
  log_id: z.string().min(1),
  notes: z.string().max(2000).optional(),
});

const bodySchema = z.discriminatedUnion("action", [
  snapshotSchema,
  executeSchema,
]);

/**
 * POST /admin/accounting/treasury/daily/log
 *
 * Two operations:
 *  - { action: "snapshot", date }       → freeze the current report into
 *                                          treasury_distribution_log
 *  - { action: "mark_executed", log_id } → mark a snapshot as actually wired.
 *                                          Returns 409 if already executed.
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
    if (body.action === "snapshot") {
      const report = await loadDailyReport(pg, body.date);
      if (report.reconciliation.delta_cents !== 0) {
        return res.status(500).json({
          success: false,
          error: "Refusing to snapshot a report with non-zero reconciliation delta",
          data: report,
        });
      }

      const id = `tdl_${ulid()}`;
      await pg.raw(
        `INSERT INTO treasury_distribution_log
           (id, distribution_date, generated_by_user_id, snapshot_json, notes)
         VALUES (?, ?, ?, ?::jsonb, ?)`,
        [id, body.date, actorId, JSON.stringify(report), body.notes ?? null]
      );

      return res.json({
        success: true,
        data: { id, distribution_date: body.date, report },
      });
    }

    // mark_executed — single-shot UPDATE; 0 rows == already executed or missing.
    const result = await pg.raw(
      `UPDATE treasury_distribution_log
       SET executed_at = now(),
           executed_by_user_id = ?,
           notes = COALESCE(?, notes)
       WHERE id = ? AND executed_at IS NULL
       RETURNING id, distribution_date, executed_at, executed_by_user_id, notes`,
      [actorId, body.notes ?? null, body.log_id]
    );

    if (!result.rows || result.rows.length === 0) {
      const existing = await pg.raw(
        `SELECT id, executed_at FROM treasury_distribution_log WHERE id = ?`,
        [body.log_id]
      );
      if (!existing.rows || existing.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: "Log entry not found",
        });
      }
      return res.status(409).json({
        success: false,
        error: "Log entry already marked as executed",
      });
    }

    return res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to write treasury log";
    return res.status(500).json({ success: false, error: message });
  }
}
