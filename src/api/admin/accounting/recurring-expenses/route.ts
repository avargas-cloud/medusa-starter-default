/**
 * GET/POST /admin/accounting/recurring-expenses — reglas de gastos recurrentes
 * (Accounting → Calendar). Leer exige nivel accounting; crear exige además el
 * PIN de supervisor EN LA RUTA (misma forma que payroll y revenue-baseline).
 *
 * Crear una regla materializa sus vencimientos de los próximos 90 días en la
 * misma request, así el calendario la muestra al instante sin esperar al job,
 * y adopta los documentos ya cargados que sean inequívocamente suyos.
 * Nunca escribe documentos, GL ni QuickBooks.
 */
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { getBusinessDateString } from "../../../../lib/date/et";
import { pgOf, requireAccounting, requirePin, resolveActorId } from "../../../../lib/calendar/recurring-http";
import {
  MATERIALIZE_HORIZON_DAYS,
  createRule,
  listRules,
  materializeRule,
} from "../../../../lib/calendar/recurring-repo";
import { adoptExistingDocuments } from "../../../../lib/calendar/occurrence-adopt";
import { addDays } from "../../../../lib/calendar/recurring-occurrences";
import { parseRecurringRule } from "../../../../lib/calendar/recurring-types";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!(await requireAccounting(req, res))) return;
  const pg = pgOf(req);
  try {
    const includeInactive = String((req.query as Record<string, unknown>).include_inactive ?? "true") !== "false";
    return res.json({ rules: await listRules(pg, includeInactive) });
  } catch {
    return res.status(500).json({ error: "Failed to load recurring expense rules" });
  }
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!(await requireAccounting(req, res))) return;
  const pg = pgOf(req);
  if (!(await requirePin(req, res, pg))) return;
  const parsed = parseRecurringRule(req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  try {
    const rule = await createRule(pg, parsed.value, resolveActorId(req));
    const today = getBusinessDateString();
    const materialized = await materializeRule(pg, rule, today, addDays(today, MATERIALIZE_HORIZON_DAYS));
    // Lo que ya está cargado para esta regla se enlaza en el acto (candidato único).
    const adopted = await adoptExistingDocuments(pg, today, addDays(today, MATERIALIZE_HORIZON_DAYS), {
      ruleId: rule.id,
      actorId: resolveActorId(req),
    });
    return res.status(201).json({ rule, materialized, adopted: adopted.adopted.length, ambiguous: adopted.ambiguous.length });
  } catch {
    return res.status(500).json({ error: "Failed to create recurring expense rule" });
  }
}
