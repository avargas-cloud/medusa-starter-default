import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import type { PoolClient } from "pg";
import { z } from "zod";

import {
  YEAR_RE,
  postYearClose,
  previewYearClose,
} from "../../../../../lib/ledger";
import {
  invalidBody,
  ledgerFailure,
} from "../../../../../lib/ledger/documents/manual-http";
import {
  accessFailure,
  assertAccounting,
} from "../../../../../lib/pos/access-level";
import { getDbPool } from "../../../../utils/db-pool";

/**
 * /admin/accounting/ledger/year-close — cierre de ejercicio (`year_close`, source_id = año).
 *
 * GET ?year=YYYY → { year, day "YYYY-12-31", status: "posted"|"not_posted", entry_id,
 *     retained_earnings: {id,name,account_type} | null  (null = key `retained_earnings` sin mapear),
 *     accounts: [{ account {id,name,account_type}, balance_cents (Σdr−Σcr del año) }],
 *     income_cents, expense_cents, net_income_cents (= income − expense) }
 *   El preview excluye los asientos year_close, así muestra lo mismo antes y después de cerrar.
 * POST { year } → 201 { status: "posted", entry_id, preview } · 200 { status: "already_posted", entry_id, preview }
 *   409 GL_ACCOUNT_MAP_MISSING (sin retained_earnings) · 409 GL_PERIOD_CLOSED (diciembre cerrado)
 *   400 GL_SOURCE_INVALID nothing_to_close
 * Asiento al YYYY-12-31: cada cuenta Income/COGS/Expense/OtherIncome/OtherExpense se lleva a cero
 * contra Retained Earnings (utilidad → Cr RE, pérdida → Dr RE).
 */
const yearSchema = z.string().regex(YEAR_RE, "year must be YYYY");
const bodySchema = z.object({ year: yearSchema }).strict();

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  try {
    await assertAccounting(req);
  } catch (error) {
    return accessFailure(res, error);
  }
  const year = yearSchema.safeParse(String(req.query.year ?? ""));
  if (!year.success)
    return res
      .status(400)
      .json({ error: "year=YYYY is required", code: "invalid_year" });

  const client: PoolClient = await getDbPool().connect();
  try {
    return res.json(await previewYearClose(client, year.data));
  } catch (error) {
    return ledgerFailure(res, error);
  } finally {
    client.release();
  }
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  let actorId: string;
  try {
    actorId = (await assertAccounting(req)).userId;
  } catch (error) {
    return accessFailure(res, error);
  }
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) return invalidBody(res, parsed.error.issues[0]?.message);

  const client: PoolClient = await getDbPool().connect();
  try {
    const result = await postYearClose(client, parsed.data.year, actorId);
    const preview = await previewYearClose(client, parsed.data.year);
    return res
      .status(result.status === "posted" ? 201 : 200)
      .json({ ...result, preview });
  } catch (error) {
    return ledgerFailure(res, error);
  } finally {
    client.release();
  }
}
