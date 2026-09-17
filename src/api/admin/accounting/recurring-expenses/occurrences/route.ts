/**
 * GET /admin/accounting/recurring-expenses/occurrences?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Los eventos del Accounting Calendar en un rango: vencimientos materializados
 * (con `overdue` derivado al leer) + la nómina proyectada desde
 * `pos_monthly_payroll` (sólo lectura). Nivel accounting. Rango máximo 400 días.
 */
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { getBusinessDateString } from "../../../../../lib/date/et";
import { occurrenceToEvent, payrollEvents, type CalendarEvent } from "../../../../../lib/calendar/calendar-events";
import { pgOf, requireAccounting } from "../../../../../lib/calendar/recurring-http";
import { listOccurrences, listRules } from "../../../../../lib/calendar/recurring-repo";
import { ISO_DATE_RE } from "../../../../../lib/calendar/recurring-types";

const MAX_RANGE_DAYS = 400;

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!(await requireAccounting(req, res))) return;
  const q = req.query as Record<string, unknown>;
  const from = String(q.from ?? "");
  const to = String(q.to ?? "");
  if (!ISO_DATE_RE.test(from) || !ISO_DATE_RE.test(to) || from > to) {
    return res.status(400).json({ error: "from/to must be YYYY-MM-DD with from <= to" });
  }
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_RANGE_DAYS) {
    return res.status(400).json({ error: `range must not exceed ${MAX_RANGE_DAYS} days` });
  }
  const pg = pgOf(req);
  try {
    const today = getBusinessDateString();
    const [rules, occurrences, payroll] = await Promise.all([
      listRules(pg, true),
      listOccurrences(pg, from, to),
      payrollEvents(pg, from, to, today),
    ]);
    const byId = new Map(rules.map((r) => [r.id, r]));
    const events: CalendarEvent[] = [];
    for (const occ of occurrences) {
      const rule = byId.get(occ.rule_id);
      if (rule) events.push(occurrenceToEvent(occ, rule, today));
    }
    events.push(...payroll);
    events.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    return res.json({ from, to, today, events, occurrences });
  } catch {
    return res.status(500).json({ error: "Failed to load calendar events" });
  }
}
