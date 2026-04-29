/**
 * src/api/admin/china-adjustment/[id]/route.ts
 *
 * GET /admin/china-adjustment/:id  — adjustment document detail with all lines
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { resolveKnex } from "../route";

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const { id } = req.params;
  const knex = resolveKnex(req);

  const { rows: docs } = await knex.raw(
    `SELECT id, notes, total_lines, created_by_user_id, created_at
     FROM china_adjustment WHERE id = $1`,
    [id]
  );

  if (!docs || (docs as unknown[]).length === 0) {
    return res.status(404).json({ error: "Adjustment not found." });
  }

  const { rows: lines } = await knex.raw(
    `SELECT id, inventory_item_id, sku, old_qty, new_qty, delta
     FROM china_adjustment_line
     WHERE china_adjustment_id = $1
     ORDER BY sku ASC`,
    [id]
  );

  return res.json({ adjustment: (docs as unknown[])[0], lines });
}
