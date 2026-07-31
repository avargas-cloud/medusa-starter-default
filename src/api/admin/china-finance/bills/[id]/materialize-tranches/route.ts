/**
 * POST /admin/china-finance/bills/:id/materialize-tranches
 *
 * Show a bill that was PAID SHORT as two ledger records — Partial #1 for the
 * money already wired, Partial #2 for what is still owed — so the short payment
 * is visible evidence in the ledger instead of a number to interpret in a
 * column.
 *
 * Deliberately a separate route from `/split`: that one takes a `pay_now_cents`
 * because the operator is DECIDING how much to pay; this one takes no body at
 * all, because the amounts are already settled by money that left the bank. A
 * route that accepted an amount here would invite someone to type one.
 *
 * No body. Idempotent by refusal: a bill already shown as partials is rejected
 * rather than split again.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { materializePaidShortTranches } from "../../../../../../lib/china-finance/bill-split-payment";

type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
  transaction?: () => Promise<
    Knex & { commit: () => Promise<void>; rollback: () => Promise<void> }
  >;
};

export const POST = async (
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) => {
  const id = req.params.id;
  if (!id) return res.status(400).json({ message: "Missing bill id" });

  const knex = (req.scope as unknown as { resolve: (k: string) => unknown })
    .resolve("__pg_connection__") as Knex;

  const trx = knex.transaction ? await knex.transaction() : null;
  const db = trx ?? knex;
  try {
    const result = await materializePaidShortTranches(db, { billId: id });
    if (trx) await trx.commit();
    return res.json({ success: true, tranches: result });
  } catch (err) {
    if (trx) await trx.rollback();
    const msg = err instanceof Error ? err.message : String(err);
    if (/not found/i.test(msg)) return res.status(404).json({ message: msg });
    // Every refusal this operation can raise is the caller describing a bill
    // that cannot be shown this way — not a server fault. They carry their own
    // sentence, and the UI shows it verbatim.
    if (/not splittable|already shown as partials|no short payment to show|owes nothing/i.test(msg)) {
      return res.status(400).json({ message: msg });
    }
    throw err;
  }
};
