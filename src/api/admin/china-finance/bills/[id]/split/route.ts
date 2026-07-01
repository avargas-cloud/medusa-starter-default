/**
 * POST /admin/china-finance/bills/:id/split
 *
 * Rule 6: split a bill on a DRAFT wire into the amount paid now (Partial #1,
 * stays on the wire) + a new unassigned Partial #(k+1) for the deferred
 * remainder. Body: { pay_now_cents }.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { z } from "zod";
import { splitBillForPartialPayment } from "../../../../../../lib/china-finance/bill-split-payment";

type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
  transaction?: () => Promise<
    Knex & { commit: () => Promise<void>; rollback: () => Promise<void> }
  >;
};

const bodySchema = z.object({ pay_now_cents: z.number().int().min(1) });

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
    const result = await splitBillForPartialPayment(db, {
      billId: id,
      payNowCents: parsed.data.pay_now_cents,
    });
    if (trx) await trx.commit();
    return res.json({ success: true, split: result });
  } catch (err) {
    if (trx) await trx.rollback();
    const msg = err instanceof Error ? err.message : String(err);
    if (/not found/i.test(msg)) return res.status(404).json({ message: msg });
    if (/not splittable|must be on a draft|must be between/i.test(msg)) {
      return res.status(400).json({ message: msg });
    }
    throw err;
  }
};
