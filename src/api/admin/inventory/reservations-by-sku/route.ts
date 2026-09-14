/**
 * GET /admin/inventory/reservations-by-sku?sku=XXX
 *
 * The decomposition of the RESERVED figure in the POS stock modal: which
 * orders hold the units, for whom, how many each. Sibling of
 * `/purchase-orders/inbound-by-sku`, which decomposes ON PO the same way.
 *
 * READ-ONLY. Nothing here writes, enqueues or touches QuickBooks.
 *
 * Response: ReservationsBySku (see lib/inventory/reservations-by-sku.ts).
 * `reserved` is the same `inventory_level.reserved_quantity` cache the badge
 * prints, so the headline and the rows cannot disagree by definition — and
 * when the rows do not reach it, `unattributed` says by how much.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { resolveReservationsBySku } from "../../../../lib/inventory/reservations-by-sku";

/** knex here is the `__pg_connection__` pool → `?` placeholders, NOT `$1`. */
type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const sku = (req.query["sku"] as string | undefined)?.trim() ?? "";

  if (!sku) {
    res.status(400).json({ error: "sku query param is required" });
    return;
  }

  const knex = req.scope.resolve("__pg_connection__") as Knex;

  res.json(await resolveReservationsBySku(knex, sku));
}
