/**
 * PATCH /admin/china-finance/bills/:id
 *
 * Edit a China Finance bill. `amount_cents` is the bill's TRUE TOTAL — it is
 * routed through the split delta engine (applyBillTotalChange), which owns all
 * partial/split/collapse behaviour (rules 1–5,7). Any other field is a plain
 * display-metadata update on this row. To change how much a wire PAYS toward a
 * bill (a deliberate partial), use PATCH /wire-transfers/reassign-bills instead.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { z } from "zod";
import { applyBillTotalChange } from "../../../../../lib/china-finance/bill-delta-engine";

type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
  transaction?: () => Promise<
    Knex & { commit: () => Promise<void>; rollback: () => Promise<void> }
  >;
};

const patchSchema = z.object({
  amount_cents: z.number().int().min(0).optional(),
  invoice_number: z.string().max(100).nullable().optional(),
  po_number: z.string().max(50).nullable().optional(),
  po_ref_number: z.string().max(50).nullable().optional(),
  payee: z.string().max(200).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
  document_date: z.string().date().nullable().optional(),
  due_date: z.string().date().nullable().optional(),
});

const META_COLUMNS = [
  "invoice_number", "po_number", "po_ref_number", "payee",
  "description", "document_date", "due_date",
] as const;

export const PATCH = async (
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Validation error", errors: parsed.error.flatten() });
  }
  const id = req.params.id;
  if (!id) return res.status(400).json({ message: "Missing bill id" });
  const knex = (req.scope as unknown as { resolve: (k: string) => unknown })
    .resolve("__pg_connection__") as Knex;

  const { amount_cents, ...meta } = parsed.data;
  const metaKeys = META_COLUMNS.filter((c) => (meta as Record<string, unknown>)[c] !== undefined);
  if (amount_cents === undefined && metaKeys.length === 0) {
    return res.status(400).json({ message: "Nothing to update" });
  }

  const existing = (
    (await knex.raw(`SELECT id, split_group_id FROM china_finance_bill WHERE id = ?`, [id])).rows as Array<{ id: string; split_group_id: string | null }>
  )[0];
  if (!existing) return res.status(404).json({ message: "Bill not found" });

  // `amount_cents` means "the whole bill's new TOTAL". It must be applied at the
  // group root — editing it on a non-root child would (via the engine) resize
  // the ENTIRE group to the child's number. Reject and make the UI send the root.
  if (amount_cents !== undefined && existing.split_group_id !== null && existing.split_group_id !== id) {
    return res.status(400).json({
      message: "amount_cents must be edited on the split-group root, not a partial child",
      root_id: existing.split_group_id,
    });
  }

  const trx = knex.transaction ? await knex.transaction() : null;
  const db = trx ?? knex;

  try {
    const delta =
      amount_cents !== undefined
        ? await applyBillTotalChange(db, {
            billId: id,
            targetTotalCents: amount_cents,
            source: "manual_edit",
          })
        : null;

    // Plain metadata (non-amount) updates on this row only.
    if (metaKeys.length > 0) {
      const binds: unknown[] = metaKeys.map((c) => (meta as Record<string, unknown>)[c]);
      binds.push(id);
      await db.raw(
        `UPDATE china_finance_bill SET ${metaKeys.map((c) => `${c} = ?`).join(", ")}, updated_at = now() WHERE id = ?`,
        binds
      );
    }

    if (trx) await trx.commit();
    return res.json({ success: true, delta });
  } catch (err) {
    if (trx) await trx.rollback();
    const msg = err instanceof Error ? err.message : String(err);
    if (/not found/i.test(msg)) return res.status(404).json({ message: msg });
    if (/not editable|invalid targetTotalCents|run split backfill|split it/i.test(msg)) {
      return res.status(400).json({ message: msg });
    }
    throw err;
  }
};
