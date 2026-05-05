/**
 * POST /admin/purchase-orders/:id/vendor-bill
 *
 * Creates a draft vendor bill from all currently unbilled receipt lines on a
 * purchase order. This supports vendor invoices that cover multiple item
 * receipts for the same PO.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { z } from "zod";

import { getActorUserId, UnauthenticatedError } from "../../_lib/auth";
import { zodErrorToBody } from "../../_lib/format";
import { getPurchaseOrdersService } from "../../_lib/service-resolver";

type KnexInstance = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

function resolveKnex(req: AuthenticatedMedusaRequest): KnexInstance {
  return (req.scope as unknown as { resolve: (k: string) => unknown }).resolve(
    "__pg_connection__"
  ) as KnexInstance;
}

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

type VendorBillBody = z.infer<typeof vendorBillBodySchema>;

interface ReceiptHeader {
  id: string;
  purchase_order_id: string;
  number: string;
  status: string;
  received_at: string | Date;
}

interface ReceiptLine {
  id: string;
  purchase_order_receipt_id: string;
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
  purchase_order_receipt_id: string;
  [key: string]: unknown;
}

async function buildBillLineData(
  req: AuthenticatedMedusaRequest,
  receiptLines: ReceiptLine[]
) {
  const service = getPurchaseOrdersService(req);
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

  return Promise.all(
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

  const { id: poId } = req.params as { id: string };
  const parsed = vendorBillBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }
  const body: VendorBillBody = parsed.data;
  const service = getPurchaseOrdersService(req);

  const po = await service.retrievePurchaseOrder(poId).catch(() => null);
  if (!po) {
    return res
      .status(404)
      .json({ error: "Purchase order not found", code: "not_found" });
  }

  const receipts = ((await service.listPurchaseOrderReceipts(
    { purchase_order_id: poId },
    { take: 1000, order: { received_at: "ASC" } }
  )) as unknown as ReceiptHeader[]).filter((r) =>
    ["applied", "synced"].includes(r.status)
  );

  if (receipts.length === 0) {
    return res.status(422).json({
      error: "Purchase order has no applied receipts to bill",
      code: "no_receipts",
    });
  }

  const receiptIds = receipts.map((r) => r.id);
  const receiptLines = (await service.listPurchaseOrderReceiptLines(
    { purchase_order_receipt_id: receiptIds },
    { take: 10000 }
  )) as unknown as ReceiptLine[];

  if (receiptLines.length === 0) {
    return res.status(422).json({
      error: "Purchase order receipts have no lines to bill",
      code: "no_lines",
    });
  }

  const existingBills = (await service.listVendorBills(
    { purchase_order_id: poId },
    { take: 1000 }
  )) as unknown as VendorBillRow[];
  const existingHeaderReceiptIds = new Set(
    existingBills.map((b) => b.purchase_order_receipt_id)
  );
  const existingBillIds = existingBills.map((b) => b.id);
  const billedLineIds = new Set<string>();

  if (existingBillIds.length > 0) {
    const existingLines = (await service.listVendorBillLines(
      { vendor_bill_id: existingBillIds },
      { take: 10000 }
    )) as unknown as Array<{ receipt_line_id: string }>;
    for (const line of existingLines) {
      billedLineIds.add(line.receipt_line_id);
    }
  }

  const billableReceiptLines = receiptLines.filter(
    (line) => !billedLineIds.has(line.id)
  );
  if (billableReceiptLines.length === 0) {
    return res.status(409).json({
      error: "All received lines on this purchase order are already billed",
      code: "already_billed",
    });
  }

  const anchorReceipt = receipts.find((r) => !existingHeaderReceiptIds.has(r.id));
  if (!anchorReceipt) {
    return res.status(409).json({
      error: "No receipt is available to anchor a new vendor bill for this PO",
      code: "already_exists",
    });
  }

  const resolvedLines = await buildBillLineData(req, billableReceiptLines);
  const knex = resolveKnex(req);
  const seqResult = await knex.raw(
    `SELECT nextval('custom_vendor_bill_seq') AS seq`
  );
  const vbNumber = `VB-${(seqResult.rows[0] as { seq: string | number }).seq}`;

  const newBill = (await service.createVendorBills({
    purchase_order_receipt_id: anchorReceipt.id,
    purchase_order_id: poId,
    number: vbNumber,
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

  const newLines = await Promise.all(
    resolvedLines.map((lineData) =>
      service.createVendorBillLines({
        ...lineData,
        vendor_bill_id: newBill.id,
      })
    )
  );

  return res.status(201).json({ vendor_bill: { ...newBill, lines: newLines } });
}
