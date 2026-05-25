import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { z } from "zod";

const bodySchema = z
  .object({
    source_qb_bank_account_id: z.string().min(1).nullable().optional(),
    qb_bank_account_id: z.string().min(1).nullable().optional(),
    is_active: z.boolean().optional(),
    label: z.string().min(1).max(64).optional(),
  })
  .refine(
    (v) =>
      v.source_qb_bank_account_id !== undefined ||
      v.qb_bank_account_id !== undefined ||
      v.is_active !== undefined ||
      v.label !== undefined,
    { message: "At least one field must be provided" }
  );

interface BucketIdParams extends Record<string, string> {
  id: string;
}

async function bankExists(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pg: any,
  bankId: string
): Promise<boolean> {
  const r = await pg.raw(
    `SELECT 1 FROM qb_bank_account
       WHERE id = ? AND deleted_at IS NULL AND is_active = TRUE
       LIMIT 1`,
    [bankId]
  );
  return Boolean(r.rows && r.rows.length > 0);
}

/**
 * PATCH /admin/accounting/treasury/buckets/:id
 *
 * Updates the bank mapping (source and/or destination), the active flag,
 * or the label of a treasury bucket. Refuses to point a bucket at a
 * deleted or inactive qb_bank_account.
 */
export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  const { id } = req.params as BucketIdParams;
  if (!id) {
    return res
      .status(400)
      .json({ success: false, error: "Missing bucket id in path" });
  }

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid body",
    });
  }
  const body = parsed.data;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pg = req.scope.resolve("__pg_connection__") as any;

  try {
    if (body.source_qb_bank_account_id) {
      if (!(await bankExists(pg, body.source_qb_bank_account_id))) {
        return res.status(400).json({
          success: false,
          error: "source_qb_bank_account_id does not reference an active bank account",
        });
      }
    }
    if (body.qb_bank_account_id) {
      if (!(await bankExists(pg, body.qb_bank_account_id))) {
        return res.status(400).json({
          success: false,
          error: "qb_bank_account_id does not reference an active bank account",
        });
      }
    }

    const sets: string[] = [];
    const params: Array<string | boolean | null> = [];
    if (body.source_qb_bank_account_id !== undefined) {
      sets.push(`source_qb_bank_account_id = ?`);
      params.push(body.source_qb_bank_account_id);
    }
    if (body.qb_bank_account_id !== undefined) {
      sets.push(`qb_bank_account_id = ?`);
      params.push(body.qb_bank_account_id);
    }
    if (body.is_active !== undefined) {
      sets.push(`is_active = ?`);
      params.push(body.is_active);
    }
    if (body.label !== undefined) {
      sets.push(`label = ?`);
      params.push(body.label);
    }
    sets.push(`updated_at = now()`);
    params.push(id);

    const result = await pg.raw(
      `UPDATE treasury_bucket SET ${sets.join(", ")} WHERE id = ?
       RETURNING id, code, label, display_order, is_active,
                 source_qb_bank_account_id, qb_bank_account_id`,
      params
    );

    if (!result.rows || result.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, error: "Treasury bucket not found" });
    }

    return res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to update treasury bucket";
    return res.status(500).json({ success: false, error: message });
  }
}
