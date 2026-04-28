/**
 * PATCH /admin/vendor-bills/:id/lines/:lineId/set-cbm
 *
 * Sets the CBM (cubic meters per unit) on a product variant and refreshes the
 * vendor_bill_line snapshot. Allowed on draft bills only.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { z } from "zod";

import { zodErrorToBody } from "../../../../../purchase-orders/_lib/format";
import { getPurchaseOrdersService } from "../../../../../purchase-orders/_lib/service-resolver";

type KnexInstance = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

const bodySchema = z.object({
  cbm: z.number().min(0).max(100),
});

export async function PATCH(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const { id: billId, lineId } = req.params as {
    id: string;
    lineId: string;
  };

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }
  const { cbm } = parsed.data;

  const knex = (
    req.scope as unknown as { resolve: (k: string) => unknown }
  ).resolve("__pg_connection__") as KnexInstance;

  const service = getPurchaseOrdersService(req);

  // Validate line belongs to this bill and bill is draft
  const lines = (await service.listVendorBillLines(
    { id: lineId, vendor_bill_id: billId },
    { take: 1 }
  )) as unknown as Array<{
    id: string;
    vendor_bill_id: string;
    product_variant_id: string;
  }>;

  const line = lines[0];
  if (!line) {
    return res
      .status(404)
      .json({ error: "Vendor bill line not found", code: "not_found" });
  }

  const bills = (await service.listVendorBills(
    { id: billId },
    { take: 1 }
  )) as unknown as Array<{ id: string; status: string }>;

  const bill = bills[0];
  if (!bill) {
    return res
      .status(404)
      .json({ error: "Vendor bill not found", code: "not_found" });
  }
  if (bill.status !== "draft") {
    return res.status(409).json({
      error: "CBM can only be updated on draft vendor bills",
      code: "not_draft",
    });
  }

  // Update product_variant.metadata.cbm
  await knex.raw(
    `UPDATE product_variant
     SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('cbm', ?::float),
         updated_at = NOW()
     WHERE id = ?`,
    [cbm, line.product_variant_id]
  );

  // Update vendor_bill_line.cbm_per_unit directly (service layer silently ignores float nullables)
  await knex.raw(
    `UPDATE vendor_bill_line
     SET cbm_per_unit = ?::float, updated_at = NOW()
     WHERE id = ?`,
    [cbm, lineId]
  );

  const result = await knex.raw(
    `SELECT * FROM vendor_bill_line WHERE id = ?`,
    [lineId]
  );

  return res.json({ vendor_bill_line: result.rows[0] ?? null });
}
