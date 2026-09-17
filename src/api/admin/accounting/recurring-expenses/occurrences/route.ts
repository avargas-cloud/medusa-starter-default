/**
 * GET /admin/accounting/recurring-expenses/occurrences?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Los eventos del Accounting Calendar en un rango: vencimientos materializados
 * (con `overdue` derivado al leer, y `paid` derivado de un `booked` cuyo
 * documento ya está posted/pagado) + la nómina proyectada desde
 * `pos_monthly_payroll` (sólo lectura). Nivel accounting. Rango máximo 400 días.
 *
 * GET ?matched_kind=gl_check|vendor_bill&matched_id=<doc id>
 *   → { occurrence, rule_name } | 404 — el backlink documento → calendario.
 */
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { getBusinessDateString } from "../../../../../lib/date/et";
import {
  matchedDocumentOf,
  occurrenceToEvent,
  payrollEvents,
  resolveMatchedDocuments,
  type CalendarEvent,
} from "../../../../../lib/calendar/calendar-events";
import { pgOf, requireAccounting } from "../../../../../lib/calendar/recurring-http";
import { findOccurrenceByDocument, getRule, listOccurrences, listRules } from "../../../../../lib/calendar/recurring-repo";
import { ISO_DATE_RE, MATCHED_KINDS } from "../../../../../lib/calendar/recurring-types";

const MAX_RANGE_DAYS = 400;

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!(await requireAccounting(req, res))) return;
  const q = req.query as Record<string, unknown>;
  const pg = pgOf(req);

  if (q.matched_kind != null || q.matched_id != null) {
    const kind = String(q.matched_kind ?? "");
    const id = String(q.matched_id ?? "");
    if (!(MATCHED_KINDS as readonly string[]).includes(kind) || !id) {
      return res.status(400).json({ error: "matched_kind and matched_id are required together" });
    }
    try {
      const occurrence = await findOccurrenceByDocument(pg, kind, id);
      if (!occurrence) return res.status(404).json({ error: "No occurrence is linked to this document" });
      const rule = await getRule(pg, occurrence.rule_id);
      return res.json({ occurrence, rule_name: rule?.name ?? null });
    } catch {
      return res.status(500).json({ error: "Failed to look up the occurrence" });
    }
  }

  const from = String(q.from ?? "");
  const to = String(q.to ?? "");
  if (!ISO_DATE_RE.test(from) || !ISO_DATE_RE.test(to) || from > to) {
    return res.status(400).json({ error: "from/to must be YYYY-MM-DD with from <= to" });
  }
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_RANGE_DAYS) {
    return res.status(400).json({ error: `range must not exceed ${MAX_RANGE_DAYS} days` });
  }
  try {
    const today = getBusinessDateString();
    const [rules, occurrences, payroll] = await Promise.all([
      listRules(pg, true),
      listOccurrences(pg, from, to),
      payrollEvents(pg, from, to, today),
    ]);
    const docs = await resolveMatchedDocuments(occurrences);
    const byId = new Map(rules.map((r) => [r.id, r]));
    const events: CalendarEvent[] = [];
    for (const occ of occurrences) {
      const rule = byId.get(occ.rule_id);
      if (rule) events.push(occurrenceToEvent(occ, rule, today, matchedDocumentOf(occ, docs)));
    }
    events.push(...payroll);
    events.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    return res.json({ from, to, today, events, occurrences });
  } catch {
    return res.status(500).json({ error: "Failed to load calendar events" });
  }
}
