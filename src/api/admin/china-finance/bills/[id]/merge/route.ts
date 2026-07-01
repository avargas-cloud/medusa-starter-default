/**
 * POST /admin/china-finance/bills/:id/merge
 *
 * Rule 7 (reverse of split): raise a partial to `new_amount_cents`, absorbing the
 * deferred remainder siblings (deleted as they empty; group collapses to un-split
 * when one row remains). Body: { new_amount_cents }.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { z } from "zod";
import { mergePartialToAmount } from "../../../../../../lib/china-finance/bill-split-payment";

type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
  transaction?: () => Promise<
    Knex & { commit: () => Promise<void>; rollback: () => Promise<void> }
  >;
};

const bodySchema = z.object({ new_amount_cents: z.number().int().min(1) });

export const POST = async (
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Validation error", errors: parsed.error.flatten() });
  }
  const id = req.params.id;
  if (!id) return res.status(400).json({ message: "Missing bill id" });

  const knex = (req.scope as unknown as { resolve: (k: string) => unknown })
    .resolve("__pg_connection__") as Knex;

  const trx = knex.transaction ? await knex.transaction() : null;
  const db = trx ?? knex;
  try {
    const result = await mergePartialToAmount(db, {
      billId: id,
      newAmountCents: parsed.data.new_amount_cents,
    });
    if (trx) await trx.commit();
    return res.json({ success: true, merge: result });
  } catch (err) {
    if (trx) await trx.rollback();
    const msg = err instanceof Error ? err.message : String(err);
    if (/not found/i.test(msg)) return res.status(404).json({ message: msg });
    if (/not mergeable|must be >|not part of|scheduled on another wire/i.test(msg)) {
      return res.status(400).json({ message: msg });
    }
    throw err;
  }
};
