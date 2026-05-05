/**
 * DELETE /admin/vendor-bills/:id/lines/:lineId
 *
 * Removes one line from a draft vendor bill. Confirmed bills are immutable
 * because they have already affected landed-cost averages.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getPurchaseOrdersService } from "../../../../purchase-orders/_lib/service-resolver";

export async function DELETE(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const { id, lineId } = req.params as { id: string; lineId: string };
  const service = getPurchaseOrdersService(req);

  const bills = (await service.listVendorBills(
    { id },
    { take: 1 }
  )) as unknown as Array<{ id: string; status: string }>;
  const bill = bills[0] ?? null;

  if (!bill) {
    return res
      .status(404)
      .json({ error: "Vendor bill not found", code: "not_found" });
  }

  if (bill.status !== "draft") {
    return res.status(409).json({
      error: "Only draft vendor bills can have lines removed",
      code: "not_draft",
    });
  }

  const lines = (await service.listVendorBillLines(
    { vendor_bill_id: id },
    { take: 1000 }
  )) as unknown as Array<{ id: string }>;

  const line = lines.find((candidate) => candidate.id === lineId);
  if (!line) {
    return res
      .status(404)
      .json({ error: "Vendor bill line not found", code: "not_found" });
  }

  if (lines.length <= 1) {
    return res.status(422).json({
      error: "Vendor bill must keep at least one line",
      code: "last_line",
    });
  }

  await service.deleteVendorBillLines(lineId);

  return res.json({
    id: lineId,
    deleted: true,
    remaining_lines: lines.length - 1,
  });
}
