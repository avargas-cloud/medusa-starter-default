import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { randomUUID } from "crypto";
import { z } from "zod";

import { getActorUserId, UnauthenticatedError } from "../../../purchase-orders/_lib/auth";
import { zodErrorToBody } from "../../../purchase-orders/_lib/format";

type KnexInstance = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

function resolveKnex(req: AuthenticatedMedusaRequest): KnexInstance {
  return (req.scope as unknown as { resolve: (k: string) => unknown }).resolve(
    "__pg_connection__"
  ) as KnexInstance;
}

const bodySchema = z.object({
  qb_account_list_id: z.string().min(1),
  description: z.string().max(500).optional(),
  amount_cents: z.number().int().min(0).max(1_000_000_000),
});

function accountAllowedForBillType(
  billType: string,
  account: { full_name: string; account_type: string }
) {
  const fullName = account.full_name.toLowerCase();
  if (billType === "service") {
    return fullName === "commission for purchase:veetech representative";
  }
  if (billType === "freight") {
    return (
      account.account_type === "CostOfGoodsSold" &&
      fullName.startsWith("freight and shipping costs")
    );
  }
  if (billType === "tariff") {
    return (
      fullName === "special duties" ||
      (account.account_type === "CostOfGoodsSold" &&
        fullName.startsWith("duties") &&
        fullName !== "duties payable")
    );
  }
  return false;
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  try {
    getActorUserId(req);
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return res
        .status(err.status)
        .json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const { id } = req.params as { id: string };
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }

  const knex = resolveKnex(req);
  const billResult = await knex.raw(
    `SELECT id, status, bill_type FROM vendor_bill WHERE id = ? AND deleted_at IS NULL`,
    [id]
  );
  const bill = (billResult.rows[0] ?? null) as
    | { id: string; status: string; bill_type: string }
    | null;
  if (!bill) {
    return res
      .status(404)
      .json({ error: "Vendor bill not found", code: "not_found" });
  }
  if (bill.status !== "draft") {
    return res.status(409).json({
      error: "Only draft vendor bills can be edited",
      code: "not_draft",
    });
  }
  if (bill.bill_type === "regular") {
    return res.status(422).json({
      error: "Regular bills use product lines, not QuickBooks account lines",
      code: "wrong_bill_type",
    });
  }

  const accountResult = await knex.raw(
    `SELECT qb_list_id, full_name, account_type
     FROM qb_account
     WHERE qb_list_id = ? AND is_active = true AND deleted_at IS NULL`,
    [parsed.data.qb_account_list_id]
  );
  const account = (accountResult.rows[0] ?? null) as
    | { qb_list_id: string; full_name: string; account_type: string }
    | null;
  if (!account) {
    return res
      .status(404)
      .json({ error: "QuickBooks account not found", code: "account_not_found" });
  }
  if (!accountAllowedForBillType(bill.bill_type, account)) {
    return res.status(422).json({
      error: `Account '${account.full_name}' is not valid for ${bill.bill_type} bills`,
      code: "account_not_allowed",
    });
  }

  const lineResult = await knex.raw(
    `INSERT INTO vendor_bill_line (
       id,
       vendor_bill_id,
       receipt_line_id,
       line_type,
       qb_account_list_id,
       qb_account_full_name,
       qb_account_type,
       product_variant_id,
       sku,
       mpn,
       description,
       qty,
       unit_cost_cents,
       cbm_per_unit,
       commission_per_unit_cents,
       freight_per_unit_cents,
       tariff_per_unit_cents,
       landed_unit_cost_cents,
       created_at,
       updated_at
     ) VALUES (
       ?,
       ?, NULL, 'qb_account', ?, ?, ?, NULL, ?, NULL, ?, 1, ?, NULL, 0, 0, 0, ?, NOW(), NOW()
     )
     RETURNING *`,
    [
      `vbl_${randomUUID().replace(/-/g, "")}`,
      id,
      account.qb_list_id,
      account.full_name,
      account.account_type,
      account.full_name,
      parsed.data.description || account.full_name,
      parsed.data.amount_cents,
      parsed.data.amount_cents,
    ]
  );

  return res.status(201).json({ vendor_bill_line: lineResult.rows[0] });
}
