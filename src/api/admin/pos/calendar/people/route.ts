/**
 * GET /admin/pos/calendar/people?q= — a quién invitar desde el calendario
 * personal: coworkers (usuarios del POS) y customers con sus emails
 * (principal / alternativo / cc). Cualquier usuario autenticado del POS: es la
 * misma información que ya ve en Customers y en Users. `q` mínimo 2 chars para
 * customers; coworkers se listan aunque `q` esté vacío.
 */
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { searchCoworkers, searchCustomers } from "../../../../../lib/calendar/people-search";

import { pgOf, targetOrRespond } from "../_lib/target";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const pg = pgOf(req);
  // Resolver la identidad prueba que hay un usuario del POS detrás del token.
  const target = await targetOrRespond(req, res, pg);
  if (!target) return;
  const q = String((req.query as Record<string, unknown>).q ?? "").trim().slice(0, 80);
  try {
    const [coworkers, customers] = await Promise.all([searchCoworkers(pg, q), searchCustomers(pg, q)]);
    return res.json({ q, coworkers, customers });
  } catch {
    return res.status(500).json({ error: "Failed to search people" });
  }
}
