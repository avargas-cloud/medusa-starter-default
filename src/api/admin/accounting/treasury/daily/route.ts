import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { z } from "zod";
import { loadDailyReport } from "../_lib/load-daily-report";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const querySchema = z
  .object({
    date: z.string().regex(DATE_RE, "date must be YYYY-MM-DD").optional(),
    from: z.string().regex(DATE_RE, "from must be YYYY-MM-DD").optional(),
    to: z.string().regex(DATE_RE, "to must be YYYY-MM-DD").optional(),
  })
  .refine((q) => Boolean(q.date) || (Boolean(q.from) && Boolean(q.to)), {
    message: "provide ?date=YYYY-MM-DD or both ?from= and ?to=",
  });

/**
 * GET /admin/accounting/treasury/daily?date=YYYY-MM-DD
 * GET /admin/accounting/treasury/daily?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Returns the treasury split report for a single day (`date`) or a consolidated
 * report over an inclusive day range (`from`..`to`). See
 * ../_lib/load-daily-report.ts for the full computation, including warnings and
 * the delta=0 reconciliation invariant. Refuses to return a report with a
 * non-zero delta (HTTP 500).
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid date",
    });
  }

  // Normalize to an inclusive [from, to] range; swap if the caller inverts them.
  const q = parsed.data;
  let from = q.date ?? q.from!;
  let to = q.date ?? q.to!;
  if (from > to) [from, to] = [to, from];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pg = req.scope.resolve("__pg_connection__") as any;

  try {
    const report = await loadDailyReport(pg, from, to);
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
