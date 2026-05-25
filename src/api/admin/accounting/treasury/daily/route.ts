import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { z } from "zod";
import { loadDailyReport } from "../_lib/load-daily-report";

const querySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
});

/**
 * GET /admin/accounting/treasury/daily?date=YYYY-MM-DD
 *
 * Returns the daily split report. See ../_lib/load-daily-report.ts for the
 * full computation, including warnings and the delta=0 reconciliation
 * invariant. Refuses to return a report with a non-zero delta (HTTP 500).
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid date",
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pg = req.scope.resolve("__pg_connection__") as any;

  try {
    const report = await loadDailyReport(pg, parsed.data.date);
    if (report.reconciliation.delta_cents !== 0) {
      return res.status(500).json({
        success: false,
        error: "Reconciliation invariant violated",
        data: report,
      });
    }
    return res.json({ success: true, data: report });
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : "Failed to compute treasury daily split";
    return res.status(500).json({ success: false, error: message });
  }
}
