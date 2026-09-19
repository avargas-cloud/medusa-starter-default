import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import type { PoolClient } from "pg";
import { refreshSuggestionsForDocument } from "../../../../../../lib/banking/suggestion-refresh-document";
import { z } from "zod";

import { reviseBankCheck } from "../../../../../../lib/ledger";
import {
  REASON_SCHEMA,
  invalidBody,
  ledgerFailure,
} from "../../../../../../lib/ledger/documents/manual-http";
import {
  bankCheckBodySchema,
  toBankCheckInput,
} from "../../../../../../lib/ledger/documents/manual-schemas";
import {
  accessFailure,
  assertAccounting,
} from "../../../../../../lib/pos/access-level";
import { getDbPool } from "../../../../../utils/db-pool";

/**
 * POST /admin/accounting/checks/:id/revise — check-revise-20260918
 *   Body: el mismo del POST/PATCH (sin `post` ni `recurring_occurrence_id`) + `reason`.
 *   Corrige EN EL LUGAR un check POSTEADO: reversa en el día original + asiento
 *   nuevo, mismo CHK-####, `CheckMod` en QuickBooks. El enlace con el Accounting
 *   Calendar no se toca (sigue booked con este documento).
 *   → 200 { check, entry_id, reversal_entry_id, qb }
 *   · 409 GL_DOCUMENT_NOT_POSTED (draft/voided) · 409 GL_PERIOD_CLOSED
 *   · 400 GL_SOURCE_INVALID con `details.reason` ∈ { revise_type_change (Bank↔CreditCard),
 *     statement_closed, entry_matched, account_not_active, other_name_not_active, … }
 */
const reviseBodySchema = bankCheckBodySchema
  .omit({ post: true, recurring_occurrence_id: true })
  .extend({ reason: REASON_SCHEMA.shape.reason })
  .strict()
  // `.omit` descarta el superRefine del body base: se repite acá.
  .superRefine((body, ctx) => {
    if (body.payee_type === "other_name" && !body.payee_id)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payee_id"],
        message: "payee_id is required when payee_type is other_name",
      });
  });

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
  const parsed = reviseBodySchema.safeParse(req.body);
  if (!parsed.success) return invalidBody(res, parsed.error.issues[0]?.message);
  const { reason, ...body } = parsed.data;

  const client: PoolClient = await getDbPool().connect();
  try {
    const result = await reviseBankCheck(
      client,
      req.params.id as string,
      toBankCheckInput({ ...body, post: false }),
      reason,
      actorId
    );
    // Committed above: the Bank Feed may be SUGGESTING the reversed line.
    await refreshSuggestionsForDocument(getDbPool(), req.params.id as string, actorId);
    return res.json(result);
  } catch (error) {
    return ledgerFailure(res, error);
  } finally {
    client.release();
  }
}
