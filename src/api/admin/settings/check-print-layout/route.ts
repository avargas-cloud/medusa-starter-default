/**
 * GET /admin/settings/check-print-layout → { layout: CheckPrintLayout, is_default: boolean }
 * PUT /admin/settings/check-print-layout → { layout: unknown } → replace the layout
 *
 * Storage: store.metadata.check_print_layout (jsonb, the whole layout object) —
 * same pattern as payment_batch_cutoff. GET is Accounting (the accountant is who
 * prints the checks); PUT is Owner-only (moving the paper alignment misprints
 * every check until fixed). A corrupt/missing metadata reads back the factory
 * default (fail-open to defaults — never blocks printing).
 */
import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getDbPool } from "../../../utils/db-pool";
import {
  checkPrintLayoutSchema,
  parseStoredCheckPrintLayout,
} from "../../../../lib/pos/check-print-layout";
import {
  accessFailure,
  assertAccounting,
  assertOwner,
} from "../../../../lib/pos/access-level";

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  try {
    await assertAccounting(req as AuthenticatedMedusaRequest);
  } catch (error) {
    return accessFailure(res, error);
  }
  try {
    const pool = getDbPool();
    const { rows } = await pool.query<{ layout: unknown }>(
      `SELECT metadata->'check_print_layout' AS layout FROM store LIMIT 1`
    );
    return res.json(parseStoredCheckPrintLayout(rows[0]?.layout));
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}

export async function PUT(
  req: AuthenticatedMedusaRequest<{ layout?: unknown }>,
  res: MedusaResponse
) {
  try {
    await assertOwner(req as AuthenticatedMedusaRequest);
  } catch (error) {
    return accessFailure(res, error);
  }
  const parsed = checkPrintLayoutSchema.safeParse(req.body?.layout);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid check print layout",
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  try {
    const pool = getDbPool();
    await pool.query(
      `UPDATE store
         SET metadata = COALESCE(metadata, '{}'::jsonb)
                        || jsonb_build_object('check_print_layout', $1::jsonb)`,
      [JSON.stringify(parsed.data)]
    );
    return res.json({ layout: parsed.data, is_default: false });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
