/**
 * GET /admin/accounting/recurring-expenses/scheduled — nivel accounting.
 *
 * La pestaña "Scheduled" del Accounting Calendar: TODAS las reglas con sus
 * vencimientos desde el 1° del mes corriente hasta el horizonte materializado
 * (90 días), cada uno con su estado operativo — overdue · due soon · booked
 * (con el documento y su link) · paid (derivado si el documento ya está
 * posted/pagado) · skipped — y con `config_issue` cuando el snapshot no
 * alcanza para abrir el documento (bill sin vendor, expense sin banco…).
 * Sólo lectura.
 */
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { getBusinessDateString } from "../../../../../lib/date/et";
import { matchedDocumentOf, resolveMatchedDocuments } from "../../../../../lib/calendar/calendar-events";
import { pgOf, requireAccounting } from "../../../../../lib/calendar/recurring-http";
import { addDays, viewStatus } from "../../../../../lib/calendar/recurring-occurrences";
import { MATERIALIZE_HORIZON_DAYS, listOccurrences, listRules } from "../../../../../lib/calendar/recurring-repo";
import type { RecurringOccurrence } from "../../../../../lib/calendar/recurring-types";

const DUE_SOON_DAYS = 7;

/** Qué le falta al snapshot para poder abrir su documento — sin pegarle a la base. */
function configIssue(occ: RecurringOccurrence): string | null {
  const kind = occ.document_kind ?? "expense";
  if (!occ.expense_account_list_id) return "No expense account";
  if (kind === "bill") {
    if (occ.payee_type !== "vendor" || !occ.payee_id) return "A bill needs a vendor payee";
    return null;
  }
  if (!occ.pay_from_account_list_id) return "No bank or card account";
  if (!occ.payee_name) return "No payee";
  return null;
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!(await requireAccounting(req, res))) return;
  const pg = pgOf(req);
  try {
    const today = getBusinessDateString();
    const from = `${today.slice(0, 7)}-01`;
    const to = addDays(today, MATERIALIZE_HORIZON_DAYS);
    const dueSoonUntil = addDays(today, DUE_SOON_DAYS);
    const [rules, occurrences] = await Promise.all([listRules(pg, true), listOccurrences(pg, from, to)]);
    const docs = await resolveMatchedDocuments(occurrences);
    const byRule = new Map<string, unknown[]>();
    for (const occ of occurrences) {
      const doc = matchedDocumentOf(occ, docs);
      const status = viewStatus(occ.status, occ.due_date, today, doc?.settled ?? false);
      const list = byRule.get(occ.rule_id) ?? [];
      list.push({
        ...occ,
        view_status: status,
        due_soon: status === "expected" && occ.due_date <= dueSoonUntil,
        document: doc,
        config_issue: occ.status === "expected" ? configIssue(occ) : null,
      });
      byRule.set(occ.rule_id, list);
    }
    return res.json({
      today,
      from,
      to,
      rules: rules.map((rule) => ({ ...rule, occurrences: byRule.get(rule.id) ?? [] })),
    });
  } catch {
    return res.status(500).json({ error: "Failed to load the schedule" });
  }
}
