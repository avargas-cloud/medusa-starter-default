import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import type { PoolClient } from "pg";
import { z } from "zod";

import {
  YEAR_RE,
  previewYearClose,
  reverseYearClose,
} from "../../../../../../lib/ledger";
import {
  invalidBody,
  ledgerFailure,
} from "../../../../../../lib/ledger/documents/manual-http";
import {
  accessFailure,
  assertAccounting,
} from "../../../../../../lib/pos/access-level";
import { getDbPool } from "../../../../../utils/db-pool";

/**
 * POST /admin/accounting/ledger/year-close/reverse { year, reason }
 *   → 201 { status: "reversed", entry_id, preview } · 404 GL_NOT_POSTED · 409 GL_ALREADY_REVERSED
 *   409 GL_PERIOD_CLOSED (el día de la reversa — hoy o el 12-31 si es posterior — cae en mes cerrado)
 */
const bodySchema = z
  .object({
    year: z.string().regex(YEAR_RE, "year must be YYYY"),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();

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
    const result = await reverseYearClose(
      client,
      parsed.data.year,
      parsed.data.reason,
      actorId
    );
    if (result.status === "nothing_to_reverse")
      return res.status(404).json({
        error: "No active year close for this year",
        code: "GL_NOT_POSTED",
      });
    if (result.status === "already_reversed")
      return res.status(409).json({
        error: "Year close already reversed",
        code: "GL_ALREADY_REVERSED",
        entry_id: result.entry_id,
      });
    const preview = await previewYearClose(client, parsed.data.year);
    return res.status(201).json({ ...result, preview });
  } catch (error) {
    return ledgerFailure(res, error);
  } finally {
    client.release();
  }
}
