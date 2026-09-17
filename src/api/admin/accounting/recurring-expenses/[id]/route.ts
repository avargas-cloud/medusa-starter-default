/**
 * PATCH/DELETE /admin/accounting/recurring-expenses/:id — editar o borrar una
 * regla. Ambas exigen nivel accounting + PIN de supervisor en la ruta.
 *
 * Editar re-materializa SÓLO el futuro no resuelto (expected con fecha >= hoy):
 * lo pagado, lo saltado y lo pasado conservan su snapshot. Borrar arrastra las
 * ocurrencias por FK (ON DELETE CASCADE) — incluidas las pagadas: una regla
 * que se borra es una que nunca debió existir; para dejar de esperarla a
 * futuro se desactiva (`is_active: false`), no se borra.
 */
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { getBusinessDateString } from "../../../../../lib/date/et";
import { pgOf, requireAccounting, requirePin, resolveActorId } from "../../../../../lib/calendar/recurring-http";
import { deleteRule, getRule, rematerializeFuture, updateRule } from "../../../../../lib/calendar/recurring-repo";
import { parseRecurringRule } from "../../../../../lib/calendar/recurring-types";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!(await requireAccounting(req, res))) return;
  const rule = await getRule(pgOf(req), String(req.params.id));
  if (!rule) return res.status(404).json({ error: "Rule not found" });
  return res.json({ rule });
}

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  if (!(await requireAccounting(req, res))) return;
  const pg = pgOf(req);
  if (!(await requirePin(req, res, pg))) return;
  const parsed = parseRecurringRule(req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  try {
    const rule = await updateRule(pg, String(req.params.id), parsed.value, resolveActorId(req));
    if (!rule) return res.status(404).json({ error: "Rule not found" });
    const materialized = await rematerializeFuture(pg, rule, getBusinessDateString());
    return res.json({ rule, materialized });
  } catch {
    return res.status(500).json({ error: "Failed to update recurring expense rule" });
  }
}

export async function DELETE(req: MedusaRequest, res: MedusaResponse) {
  if (!(await requireAccounting(req, res))) return;
  const pg = pgOf(req);
  if (!(await requirePin(req, res, pg))) return;
  try {
    const removed = await deleteRule(pg, String(req.params.id));
    if (!removed) return res.status(404).json({ error: "Rule not found" });
    return res.json({ deleted: true });
  } catch {
    return res.status(500).json({ error: "Failed to delete recurring expense rule" });
  }
}
