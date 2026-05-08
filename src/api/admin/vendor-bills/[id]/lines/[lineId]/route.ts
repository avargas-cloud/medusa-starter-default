/**
 * DELETE /admin/vendor-bills/:id/lines/:lineId
 *
 * Removes or updates one line from an editable vendor bill.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { z } from "zod";

import { zodErrorToBody } from "../../../../purchase-orders/_lib/format";
import { getPurchaseOrdersService } from "../../../../purchase-orders/_lib/service-resolver";

type KnexInstance = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

const patchSchema = z.object({
  amount_cents: z.number().int().min(0).max(1_000_000_000).optional(),
  description: z.string().max(500).optional(),
});

function resolveKnex(req: AuthenticatedMedusaRequest): KnexInstance {
  return (req.scope as unknown as { resolve: (k: string) => unknown }).resolve(
    "__pg_connection__"
  ) as KnexInstance;
}

function isEditableStatus(status: string) {
  return status === "draft" || status === "confirmed";
}

export async function PATCH(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const { id, lineId } = req.params as { id: string; lineId: string };
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }

  const knex = resolveKnex(req);
  const result = await knex.raw(
    `SELECT
       vb.id AS vendor_bill_id,
       vb.status,
       vbl.id AS line_id,
       vbl.line_type
     FROM vendor_bill vb
     JOIN vendor_bill_line vbl
       ON vbl.vendor_bill_id = vb.id AND vbl.deleted_at IS NULL
     WHERE vb.id = ?
       AND vbl.id = ?
       AND vb.deleted_at IS NULL`,
    [id, lineId]
  );
  const row = (result.rows[0] ?? null) as
    | { status: string; line_id: string; line_type: string }
    | null;
  if (!row) {
    return res
      .status(404)
      .json({ error: "Vendor bill line not found", code: "not_found" });
  }
  if (!isEditableStatus(row.status)) {
    return res.status(409).json({
      error: "Only draft or confirmed vendor bills can be edited",
      code: "not_editable",
    });
  }
  if (row.line_type !== "qb_account") {
    return res.status(422).json({
      error: "Only account line amounts can be edited here",
      code: "wrong_line_type",
    });
  }

  const updates: string[] = [];
  const bindings: unknown[] = [];
  if (parsed.data.amount_cents !== undefined) {
    updates.push("unit_cost_cents = ?");
    bindings.push(parsed.data.amount_cents);
    updates.push("landed_unit_cost_cents = ?");
    bindings.push(parsed.data.amount_cents);
  }
  if (parsed.data.description !== undefined) {
    updates.push("description = ?");
    bindings.push(parsed.data.description);
  }
  if (updates.length === 0) {
    return res.status(400).json({
      error: "No editable fields were provided",
      code: "empty_update",
    });
  }

  const updated = await knex.raw(
    `UPDATE vendor_bill_line
     SET ${updates.join(", ")}, updated_at = NOW()
     WHERE id = ?
       AND vendor_bill_id = ?
       AND deleted_at IS NULL
     RETURNING *`,
    [...bindings, lineId, id]
  );

  return res.json({ vendor_bill_line: updated.rows[0] ?? null });
}

export async function DELETE(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const { id, lineId } = req.params as { id: string; lineId: string };
  const service = getPurchaseOrdersService(req);

  const bills = (await service.listVendorBills(
    { id },
    { take: 1 }
  )) as unknown as Array<{ id: string; status: string; bill_type?: string }>;
  const bill = bills[0] ?? null;

  if (!bill) {
    return res
      .status(404)
      .json({ error: "Vendor bill not found", code: "not_found" });
  }

  if (!isEditableStatus(bill.status)) {
    return res.status(409).json({
      error: "Only draft or confirmed vendor bills can have lines removed",
      code: "not_editable",
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

  if ((bill.bill_type ?? "regular") === "regular" && lines.length <= 1) {
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
