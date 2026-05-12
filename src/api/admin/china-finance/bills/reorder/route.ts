/**
 * PATCH /admin/china-finance/bills/reorder
 *
 * Updates sort_order for multiple pending bills at once.
 * Body: { items: [{ id: string, sort_order: number }] }
 * Only bills without a wire_transfer_id can be reordered.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { z } from "zod";

type Knex = { raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }> };

const reorderSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      sort_order: z.number().int().min(0),
    })
  ).min(1).max(500),
});

export const PATCH = async (
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) => {
  const parsed = reorderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Validation error", errors: parsed.error.flatten() });
  }

  const knex = (req.scope as unknown as { resolve: (k: string) => unknown })
    .resolve("__pg_connection__") as Knex;

  const { items } = parsed.data;
  const ids = items.map((i) => i.id);

  // Verify all items are pending (no wire assigned)
  const { rows: bills } = await knex.raw(
    `SELECT id, wire_transfer_id FROM china_finance_bill WHERE id = ANY(?)`,
    [ids]
  ) as { rows: Array<{ id: string; wire_transfer_id: string | null }> };

  const locked = bills.filter((b) => b.wire_transfer_id !== null);
  if (locked.length > 0) {
    return res.status(400).json({
      message: "Cannot reorder bills already assigned to a wire transfer",
      ids: locked.map((b) => b.id),
    });
  }

  // Bulk update via CASE statement
  const caseExpr = items.map(() => "WHEN id = ? THEN ?").join(" ");
  const bindings: unknown[] = [];
  for (const item of items) {
    bindings.push(item.id, item.sort_order);
  }
  bindings.push(ids);

  await knex.raw(
    `UPDATE china_finance_bill
       SET sort_order = CASE ${caseExpr} END,
           updated_at = now()
     WHERE id = ANY(?)`,
    bindings
  );

  return res.json({ success: true });
};
