/**
 * PATCH /admin/vendor-bills/:id/lines/:lineId/set-cbm
 *
 * Sets the CBM (cubic meters per unit) on a product variant and refreshes the
 * vendor_bill_line snapshot.
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

  // Validate line belongs to this bill and bill is editable.
  const lines = (await service.listVendorBillLines(
    { id: lineId, vendor_bill_id: billId },
    { take: 1 }
  )) as unknown as Array<{
    id: string;
    vendor_bill_id: string;
    product_variant_id: string;
  }>;

  const bills = (await service.listVendorBills(
    { id: billId },
    { take: 1 }
  )) as unknown as Array<{
    id: string;
    status: string;
    service_vendor_bill_id: string | null;
    freight_vendor_bill_id: string | null;
    tariff_vendor_bill_id: string | null;
  }>;

  const line = lines[0];
  if (!line) {
    return res
      .status(404)
      .json({ error: "Vendor bill line not found", code: "not_found" });
  }

  const bill = bills[0];
  if (!bill) {
    return res
      .status(404)
      .json({ error: "Vendor bill not found", code: "not_found" });
  }
  // Draft-only: a confirmed bill is frozen history — its cbm_per_unit snapshot
  // must never change. Update a product's CBM globally via the Freight Specs page
  // (dimension-derived); it will apply to FUTURE bills without touching this one.
  if (bill.status !== "draft") {
    return res.status(409).json({
      error:
        "CBM can only be edited on draft vendor bills. Use the Freight Specs page to update a product's CBM (it applies to future bills without altering confirmed history).",
      code: "confirmed_bill_cbm_locked",
    });
  }

  // China vs local is a property of the DOCUMENT, not the vendor: a bill is
  // China-agent if it points at any sibling (service/freight/tariff); all
  // three NULL means local/USA. Never use `qb_clearing_lines` for this — that
  // column is only written once the bill has already shipped to QuickBooks,
  // so a China draft would read as local.
  const isChinaBill = Boolean(
    bill.service_vendor_bill_id ||
      bill.freight_vendor_bill_id ||
      bill.tariff_vendor_bill_id
  );

  // Update vendor_bill_line.cbm_per_unit directly (service layer silently ignores float nullables)
  await knex.raw(
    `UPDATE vendor_bill_line
     SET cbm_per_unit = ?::float, updated_at = NOW()
     WHERE id = ?`,
    [cbm, lineId]
  );

  // Update product_variant.metadata.cbm ONLY for China bills. A China product
  // is repurchased and its CBM is a real catalog fact, so it is meant to be
  // reused on the next bill. A local/USA purchase is typically one-off — its
  // CBM is estimated by eyeballing the box for THIS shipment — so writing it
  // to the product would leak that one-off estimate into unrelated future
  // purchases that happen to reuse the same SKU.
  if (isChinaBill) {
    await knex.raw(
      `UPDATE product_variant
       SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('cbm', ?::float),
           updated_at = NOW()
       WHERE id = ?`,
      [cbm, line.product_variant_id]
    );
  }

  const result = await knex.raw(
    `SELECT * FROM vendor_bill_line WHERE id = ?`,
    [lineId]
  );

  return res.json({
    vendor_bill_line: result.rows[0] ?? null,
    scope: isChinaBill ? "bill_line_and_product" : "bill_line",
  });
}
