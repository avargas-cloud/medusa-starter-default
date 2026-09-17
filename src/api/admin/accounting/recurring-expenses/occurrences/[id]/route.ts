/**
 * PATCH /admin/accounting/recurring-expenses/occurrences/:id — nivel accounting.
 *
 *   { status: expected|paid|skipped, actual_amount_cents?, actual_date?, note? }
 *     marcar un vencimiento como pagado / saltado / volver a esperado.
 *   { due_date: YYYY-MM-DD }
 *     mover ESTA ocurrencia de día (`due_date_override`); la regla no se toca y
 *     la re-materialización la respeta. Sólo `expected`.
 *
 * Son afirmaciones del contador sobre un hecho, no un movimiento de dinero:
 * no crean documento, no tocan GL ni QB, y por eso no piden PIN (las reglas sí).
 * Lo que NO se puede afirmar por acá: `booked` (lo pone el documento al nacer)
 * y reabrir una ocurrencia ENLAZADA (409 OCCURRENCE_LINKED — se anula o borra
 * el documento, que es quien la desenlaza).
 */
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import {
  OccurrenceError,
  moveOccurrence,
  occurrenceErrorStatus,
  patchOccurrence,
} from "../../../../../../lib/calendar/occurrence-link";
import { pgOf, requireAccounting, resolveActorId } from "../../../../../../lib/calendar/recurring-http";
import { parseOccurrenceMove, parseOccurrencePatch } from "../../../../../../lib/calendar/recurring-types";

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  if (!(await requireAccounting(req, res))) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const isMove = body.due_date != null && body.status == null;
  const pg = pgOf(req);
  const id = String(req.params.id);
  const actorId = resolveActorId(req);
  try {
    if (isMove) {
      const parsed = parseOccurrenceMove(body);
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });
      const occurrence = await moveOccurrence(pg, id, parsed.value.due_date, actorId);
      if (!occurrence) return res.status(404).json({ error: "Occurrence not found" });
      return res.json({ occurrence });
    }
    const parsed = parseOccurrencePatch(body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const occurrence = await patchOccurrence(pg, id, parsed.value, actorId);
    if (!occurrence) return res.status(404).json({ error: "Occurrence not found" });
    return res.json({ occurrence });
  } catch (error) {
    if (error instanceof OccurrenceError)
      return res.status(occurrenceErrorStatus(error.code)).json({ error: error.message, code: error.code });
    return res.status(500).json({ error: "Failed to update occurrence" });
  }
}
