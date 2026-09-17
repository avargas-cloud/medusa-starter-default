/**
 * PATCH /admin/accounting/recurring-expenses/occurrences/:id — marcar un
 * vencimiento como pagado / saltado / volver a esperado. Nivel accounting.
 *
 * Es una afirmación del contador sobre un hecho, no un movimiento de dinero:
 * no crea documento, no toca GL ni QB, y por eso no pide PIN (las reglas sí).
 */
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { pgOf, requireAccounting, resolveActorId } from "../../../../../../lib/calendar/recurring-http";
import { patchOccurrence } from "../../../../../../lib/calendar/recurring-repo";
import { parseOccurrencePatch } from "../../../../../../lib/calendar/recurring-types";

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  if (!(await requireAccounting(req, res))) return;
  const parsed = parseOccurrencePatch(req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  try {
    const occurrence = await patchOccurrence(pgOf(req), String(req.params.id), parsed.value, resolveActorId(req));
    if (!occurrence) return res.status(404).json({ error: "Occurrence not found" });
    return res.json({ occurrence });
  } catch {
    return res.status(500).json({ error: "Failed to update occurrence" });
  }
}
