/**
 * GET /admin/accounting/recurring-expenses/occurrences/:id/prefill — nivel
 * accounting. Lo que el editor de documento necesita para abrirse PRE-LLENADO
 * desde esta ocurrencia (payee, cuentas, monto, fecha, memo, kind), resuelto
 * desde su SNAPSHOT. `blocked` nombra lo que falta en la regla; `existing`
 * dice que ya hay un documento. No escribe nada.
 */
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { buildOccurrencePrefill } from "../../../../../../../lib/calendar/occurrence-prefill";
import { pgOf, requireAccounting } from "../../../../../../../lib/calendar/recurring-http";
import { getOccurrence, getRule } from "../../../../../../../lib/calendar/recurring-repo";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!(await requireAccounting(req, res))) return;
  const pg = pgOf(req);
  try {
    const occurrence = await getOccurrence(pg, String(req.params.id));
    if (!occurrence) return res.status(404).json({ error: "Occurrence not found" });
    const rule = await getRule(pg, occurrence.rule_id);
    if (!rule) return res.status(404).json({ error: "Rule not found" });
    return res.json({ prefill: await buildOccurrencePrefill(occurrence, rule) });
  } catch {
    return res.status(500).json({ error: "Failed to build the prefill" });
  }
}
