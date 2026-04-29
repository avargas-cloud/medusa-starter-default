/**
 * src/api/admin/purchase-orders/[id]/receipts/[receiptId]/vendor-bill/route.ts
 *
 * GET  /admin/purchase-orders/:id/receipts/:receiptId/vendor-bill
 *   → Returns the vendor bill for this receipt (404 if not yet created).
 *
 * POST /admin/purchase-orders/:id/receipts/:receiptId/vendor-bill
 *   → Creates a draft vendor bill for this receipt (idempotent: 409 if already
 *     exists). Also creates vendor_bill_lines from the receipt lines.
 *
 * PATCH /admin/purchase-orders/:id/receipts/:receiptId/vendor-bill
 *   → Updates draft vendor bill fields. Only allowed when status='draft'.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { z } from "zod";

import { getActorUserId, UnauthenticatedError } from "../../../../_lib/auth";
import { zodErrorToBody } from "../../../../_lib/format";
import { getPurchaseOrdersService } from "../../../../_lib/service-resolver";

type KnexInstance = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

function resolveKnex(req: AuthenticatedMedusaRequest): KnexInstance {
  return (req.scope as unknown as { resolve: (k: string) => unknown }).resolve(
    "__pg_connection__"
  ) as KnexInstance;
}

// ── Zod schemas ───────────────────────────────────────────────────────────────

const vendorBillBodySchema = z.object({
  commission_mode: z.enum(["percent", "fixed"]).default("percent"),
  commission_rate_bps: z
    .number()
    .int()
    .min(0)
    .max(100_000)
    .optional()
    .default(0),
  commission_amount_cents: z
    .number()
    .int()
    .min(0)
    .max(1_000_000_000)
    .optional()
    .default(0),
  commission_invoice_number: z.string().max(200).nullish(),
  reference_id: z.string().max(200).nullish(),
  freight_included: z.boolean().optional().default(false),
  freight_amount_cents: z
    .number()
    .int()
    .min(0)
    .max(1_000_000_000)
    .optional()
    .default(0),
  freight_invoice_number: z.string().max(200).nullish(),
  tariff_included: z.boolean().optional().default(false),
  tariff_amount_cents: z
    .number()
    .int()
    .min(0)
    .max(1_000_000_000)
    .optional()
    .default(0),
  tariff_number: z.string().max(200).nullish(),
  notes: z.string().max(2000).nullish(),
});

const vendorBillPatchSchema = vendorBillBodySchema.partial();

type VendorBillBody = z.infer<typeof vendorBillBodySchema>;
type VendorBillPatch = z.infer<typeof vendorBillPatchSchema>;

// ── Typed shapes from service ────────────────────────────────────────────────

interface ReceiptHeader {
  id: string;
  purchase_order_id: string;
  status: string;
}

interface ReceiptLine {
  id: string;
  purchase_order_line_id: string;
  product_variant_id: string;
  sku_snapshot: string;
  description_snapshot: string;
  qty_received_now: number;
  unit_cost_cents_override: number | null;
}

interface PoLine {
  id: string;
  unit_cost_cents: number;
}

interface VendorBillRow {
  id: string;
  status: string;
  [key: string]: unknown;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function resolveReceiptAndBill(
  service: ReturnType<typeof getPurchaseOrdersService>,
  poId: string,
  receiptId: string
): Promise<
  | {
      receipt: ReceiptHeader;
      bill: VendorBillRow | null;
    }
  | { error: string; code: string; status: number }
> {
  const receipt = (await service
    .retrievePurchaseOrderReceipt(receiptId)
    .catch(() => null)) as unknown as ReceiptHeader | null;

  if (!receipt) {
    return { error: "Receipt not found", code: "not_found", status: 404 };
  }
  if (receipt.purchase_order_id !== poId) {
    return {
      error: "Receipt does not belong to this purchase order",
      code: "receipt_mismatch",
      status: 400,
    };
  }

  const bills = (await service.listVendorBills(
    { purchase_order_receipt_id: receiptId },
    { take: 1 }
  )) as unknown as VendorBillRow[];

  return { receipt, bill: bills[0] ?? null };
}

function isErrorResult(
  r: unknown
): r is { error: string; code: string; status: number } {
  return typeof r === "object" && r !== null && "error" in r;
}

// ── GET ──────────────────────────────────────────────────────────────────────

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const { id, receiptId } = req.params as { id: string; receiptId: string };
  const service = getPurchaseOrdersService(req);

  const resolved = await resolveReceiptAndBill(service, id, receiptId);
  if (isErrorResult(resolved)) {
    return res
      .status(resolved.status)
      .json({ error: resolved.error, code: resolved.code });
  }

  const { bill } = resolved;
  if (!bill) {
    return res
      .status(404)
      .json({ error: "Vendor bill not found", code: "not_found" });
  }

  // Fetch lines
  const lines = await service.listVendorBillLines(
    { vendor_bill_id: bill.id },
    { take: 1000 }
  );

  return res.json({ vendor_bill: { ...bill, lines } });
}

// ── POST ─────────────────────────────────────────────────────────────────────

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  let userId: string;
  try {
    userId = getActorUserId(req);
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return res
        .status(err.status)
        .json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const { id, receiptId } = req.params as { id: string; receiptId: string };

  const parsed = vendorBillBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }
  const body: VendorBillBody = parsed.data;

  const service = getPurchaseOrdersService(req);

  const resolved = await resolveReceiptAndBill(service, id, receiptId);
  if (isErrorResult(resolved)) {
    return res
      .status(resolved.status)
      .json({ error: resolved.error, code: resolved.code });
  }

  const { bill: existing } = resolved;
  if (existing) {
    return res.status(409).json({
      error: "A vendor bill already exists for this receipt",
      code: "already_exists",
      vendor_bill_id: existing.id,
    });
  }

  // Fetch receipt lines to create bill lines
  const receiptLines = (await service.listPurchaseOrderReceiptLines(
    { purchase_order_receipt_id: receiptId },
    { take: 1000 }
  )) as unknown as ReceiptLine[];

  if (receiptLines.length === 0) {
    return res.status(422).json({
      error: "Receipt has no lines — cannot create vendor bill",
      code: "no_lines",
    });
  }

  // Fetch MPN + CBM from product_variant.metadata for each unique variant
  const knex = resolveKnex(req);
  const uniqueVariantIds = [
    ...new Set(receiptLines.map((rl) => rl.product_variant_id)),
  ];
  const variantMeta = new Map<string, { mpn: string | null; cbm: number | null }>();
  await Promise.all(
    uniqueVariantIds.map(async (variantId) => {
      const result = await knex.raw(
        `SELECT metadata FROM product_variant WHERE id = ? AND deleted_at IS NULL`,
        [variantId]
      );
      const row = (result.rows[0] ?? null) as
        | { metadata: Record<string, unknown> | null }
        | null;
      const mpn =
        typeof row?.metadata?.mpn === "string" ? row.metadata.mpn : null;
      const cbmRaw =
        row?.metadata?.cbm !== undefined && row.metadata.cbm !== null
          ? Number(row.metadata.cbm)
          : null;
      const cbm = cbmRaw !== null && !isNaN(cbmRaw) ? cbmRaw : null;
      variantMeta.set(variantId, { mpn, cbm });
    })
  );

  // For each line, resolve unit cost (override → PO line fallback)
  const resolvedLines = await Promise.all(
    receiptLines.map(async (rl) => {
      let unitCost = rl.unit_cost_cents_override;
      if (unitCost === null || unitCost === undefined) {
        const poLine = (await service
          .retrievePurchaseOrderLine(rl.purchase_order_line_id)
          .catch(() => null)) as unknown as PoLine | null;
        unitCost = poLine?.unit_cost_cents ?? 0;
      }
      const meta = variantMeta.get(rl.product_variant_id) ?? {
        mpn: null,
        cbm: null,
      };
      return {
        receipt_line_id: rl.id,
        product_variant_id: rl.product_variant_id,
        sku: rl.sku_snapshot,
        mpn: meta.mpn,
        description: rl.description_snapshot,
        qty: rl.qty_received_now,
        unit_cost_cents: unitCost,
        cbm_per_unit: meta.cbm,
        commission_per_unit_cents: 0,
        freight_per_unit_cents: 0,
        tariff_per_unit_cents: 0,
        landed_unit_cost_cents: 0,
      };
    })
  );

  // Create vendor bill header — number assigned at confirm, not at draft creation
  const newBill = (await service.createVendorBills({
    purchase_order_receipt_id: receiptId,
    purchase_order_id: id,
    number: null,
    status: "draft",
    reference_id: body.reference_id ?? null,
    commission_mode: body.commission_mode,
    commission_rate_bps: body.commission_rate_bps,
    commission_amount_cents: body.commission_amount_cents,
    commission_invoice_number: body.commission_invoice_number ?? null,
    freight_included: body.freight_included,
    freight_amount_cents: body.freight_amount_cents,
    freight_invoice_number: body.freight_invoice_number ?? null,
    tariff_included: body.tariff_included,
    tariff_amount_cents: body.tariff_amount_cents,
    tariff_number: body.tariff_number ?? null,
    notes: body.notes ?? null,
    confirmed_at: null,
    confirmed_by_user_id: null,
  })) as unknown as VendorBillRow;

  // Create vendor bill lines
  const newLines = await Promise.all(
    resolvedLines.map((lineData) =>
      service.createVendorBillLines({
        ...lineData,
        vendor_bill_id: newBill.id,
      })
    )
  );

  // Suppress unused variable warning — userId used for audit trail
  void userId;

  return res.status(201).json({ vendor_bill: { ...newBill, lines: newLines } });
}

// ── PATCH ────────────────────────────────────────────────────────────────────

export async function PATCH(
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

  const { id, receiptId } = req.params as { id: string; receiptId: string };

  const parsed = vendorBillPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }
  const patch: VendorBillPatch = parsed.data;

  const service = getPurchaseOrdersService(req);

  const resolved = await resolveReceiptAndBill(service, id, receiptId);
  if (isErrorResult(resolved)) {
    return res
      .status(resolved.status)
      .json({ error: resolved.error, code: resolved.code });
  }

  const { bill } = resolved;
  if (!bill) {
    return res
      .status(404)
      .json({ error: "Vendor bill not found", code: "not_found" });
  }
  if (bill.status !== "draft") {
    return res.status(409).json({
      error: `Cannot update a vendor bill in status '${bill.status}'. Only draft bills can be edited.`,
      code: "not_draft",
    });
  }

  const updatePayload: Record<string, unknown> = {};
  if ("reference_id" in patch)
    updatePayload.reference_id = patch.reference_id ?? null;
  if (patch.commission_mode !== undefined)
    updatePayload.commission_mode = patch.commission_mode;
  if (patch.commission_rate_bps !== undefined)
    updatePayload.commission_rate_bps = patch.commission_rate_bps;
  if (patch.commission_amount_cents !== undefined)
    updatePayload.commission_amount_cents = patch.commission_amount_cents;
  if ("commission_invoice_number" in patch)
    updatePayload.commission_invoice_number =
      patch.commission_invoice_number ?? null;
  if (patch.freight_included !== undefined)
    updatePayload.freight_included = patch.freight_included;
  if (patch.freight_amount_cents !== undefined)
    updatePayload.freight_amount_cents = patch.freight_amount_cents;
  if ("freight_invoice_number" in patch)
    updatePayload.freight_invoice_number = patch.freight_invoice_number ?? null;
  if (patch.tariff_included !== undefined)
    updatePayload.tariff_included = patch.tariff_included;
  if (patch.tariff_amount_cents !== undefined)
    updatePayload.tariff_amount_cents = patch.tariff_amount_cents;
  if ("tariff_number" in patch)
    updatePayload.tariff_number = patch.tariff_number ?? null;
  if ("notes" in patch) updatePayload.notes = patch.notes ?? null;

  const updated = await service.updateVendorBills(
    { id: bill.id },
    updatePayload
  );

  const lines = await service.listVendorBillLines(
    { vendor_bill_id: bill.id },
    { take: 1000 }
  );

  return res.json({ vendor_bill: { ...updated, lines } });
}
