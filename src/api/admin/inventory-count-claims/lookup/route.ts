/**
 * src/api/admin/inventory-count-claims/lookup/route.ts
 *
 * POST /admin/inventory-count-claims/lookup
 *
 * Read-only: given a set of inventory items and a location, report which of
 * them are already held by an armed inventory count (submitted /
 * partially_applied) and by which count.
 *
 * The POS calls this before adding lines — especially for a SKU-prefix bulk add,
 * where one prefix can pull in hundreds of SKUs — so the cashier learns a SKU is
 * taken BEFORE walking to the shelf to count it, and sees the number of the
 * count that holds it.
 *
 * POST rather than GET on purpose: a prefix match can carry hundreds of ids, and
 * that does not belong in a query string.
 *
 * It lives at its own top-level path, NOT under /admin/inventory-counts/*, so it
 * does not get swept up by the `/admin/inventory-counts/:id/*` POST matcher that
 * applies the closed-accounting-period guard. This route mutates nothing and
 * must stay callable while a period is closed.
 *
 * This is a CONVENIENCE, not the gate. The authoritative refusals live in
 * POST /admin/inventory-counts/:id/submit and .../approve, which re-check under
 * the database primary key. A stale answer here can only cost a wasted trip to
 * the shelf, never a double-applied delta.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/utils";
import type { Knex } from "knex";
import { z } from "zod";

import { findItemClaimOwners } from "../../../../lib/inventory-count/item-claims";

const lookupSchema = z.object({
  stock_location_id: z.string().min(1),
  inventory_item_ids: z.array(z.string().min(1)).min(1).max(5000),
});

export async function POST(
  req: AuthenticatedMedusaRequest<z.infer<typeof lookupSchema>>,
  res: MedusaResponse
) {
  const parsed = lookupSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "invalid payload",
      code: "invalid_payload",
      details: parsed.error.flatten(),
    });
  }

  const { stock_location_id, inventory_item_ids } = parsed.data;

  const knex = req.scope.resolve(
    ContainerRegistrationKeys.PG_CONNECTION
  ) as Knex;

  const owners = await findItemClaimOwners(
    knex,
    inventory_item_ids,
    stock_location_id
  );

  return res.json({
    stock_location_id,
    claims: Array.from(owners.values()).map((o) => ({
      inventory_item_id: o.inventory_item_id,
      inventory_count_id: o.inventory_count_id,
      inventory_count_number: o.inventory_count_number,
      inventory_count_status: o.inventory_count_status,
    })),
  });
}
