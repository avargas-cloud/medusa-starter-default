import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { getBusinessDateString } from "../../../../../lib/date/et";
import { isPeriod, previousPeriod } from "../../../../../lib/sales-tax/due-dates";
import { listPeriods } from "../../../../../lib/sales-tax/period-engine";
import { loadSalesTaxSettings } from "../../../../../lib/sales-tax/settings";

import { withAccounting } from "../_lib/common";

const DEFAULT_FROM = "2025-12";

/**
 * GET /admin/accounting/sales-tax/periods?from=YYYY-MM&to=YYYY-MM
 *   → { from, to, today, settings: { ready, missing }, periods: PeriodSummary[] (más reciente primero) }
 * Default: desde 2025-12 (el primer pago de 2026 lo cubre) hasta el mes corriente.
 */
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const today = getBusinessDateString();
  const current = today.slice(0, 7);
  const from = typeof req.query.from === "string" && isPeriod(req.query.from) ? req.query.from : DEFAULT_FROM;
  const to = typeof req.query.to === "string" && isPeriod(req.query.to) ? req.query.to : current;
  if (from > to) {
    res.status(400).json({ error: "from must be <= to", code: "invalid_range" });
    return;
  }
  await withAccounting(req, res, async (client) => {
    const settings = await loadSalesTaxSettings(client);
    const periods = await listPeriods(client, settings, from, to, today);
    res.json({
      from,
      to,
      today,
      current_period: previousPeriod(current),
      settings: { ready: settings.ready, missing: settings.missing, variance_tolerance_cents: settings.variance_tolerance_cents },
      periods: periods.reverse(),
    });
  });
}
