/**
 * src/workflows/purchase-orders/steps/validate-po-for-submit-step.ts
 *
 * Pure-decision step executed before a draft PO transitions to `submitted`.
 *
 * Rejects with a descriptive error when:
 *   - PO status is NOT 'draft'
 *   - PO has zero lines
 *   - Any line has qty_ordered <= 0
 *   - Any line is missing inventory_item_id or product_variant_id
 *   - Any line is missing qb_item_list_id_snapshot (QB PurchaseOrderAdd cannot reference an unsynced item)
 *   - Vendor cannot be resolved OR vendor has no qb_list_id (QB PurchaseOrderAdd requires VendorRef)
 *
 * Returns the resolved vendor snapshot so later steps can reuse it without
 * re-querying.
 */

import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";

import { PURCHASE_ORDERS_MODULE } from "../../../modules/purchase-orders";
import type PurchaseOrdersModuleService from "../../../modules/purchase-orders/service";

export interface ValidatePoForSubmitStepInput {
  po_id: string;
}

export interface ValidatedVendor {
  vendor_id: string;
  vendor_name: string;
  vendor_qb_list_id: string;
}

export interface ValidatedPoLine {
  line_id: string;
  product_variant_id: string;
  inventory_item_id: string;
  sku: string;
  description: string;
  qb_item_list_id: string;
  qty_ordered: number;
  unit_cost_cents: number;
  total_cents: number;
}

export interface ValidatePoForSubmitStepOutput {
  po: {
    id: string;
    vendor_id: string;
    stock_location_id: string;
    memo: string | null;
    reference_number: string | null;
    expected_at: Date | null;
    ordered_at: Date | null;
    subtotal_cents: number;
    tax_cents: number;
    shipping_cents: number;
    other_fees_cents: number;
    total_cents: number;
  };
  vendor: ValidatedVendor;
  lines: ValidatedPoLine[];
}

interface QbVendorLike {
  id: string;
  qb_list_id: string | null;
  full_name: string | null;
  name: string;
}

interface QbCatalogServiceLike {
  retrieveQbVendor: (id: string) => Promise<QbVendorLike | null>;
}

export const validatePoForSubmitStep = createStep(
  "validate-po-for-submit",
  async (
    input: ValidatePoForSubmitStepInput,
    { container }
  ): Promise<StepResponse<ValidatePoForSubmitStepOutput, null>> => {
    const poService = container.resolve(
      PURCHASE_ORDERS_MODULE
    ) as unknown as PurchaseOrdersModuleService;

    const poRow = (await poService.retrievePurchaseOrder(
      input.po_id
    )) as unknown as Record<string, unknown> | null;

    if (!poRow) {
      throw new Error(`Purchase order ${input.po_id} not found`);
    }

    const status = poRow.status as string;
    if (status !== "draft") {
      throw new Error(
        `Purchase order ${input.po_id} is ${status}; only drafts can be submitted`
      );
    }

    const lineRows = (await poService.listPurchaseOrderLines(
      { purchase_order_id: input.po_id },
      { take: 1000 }
    )) as unknown as Array<Record<string, unknown>>;

    if (lineRows.length === 0) {
      throw new Error(
        `Purchase order ${input.po_id} has no lines; cannot submit`
      );
    }

    const validated: ValidatedPoLine[] = [];
    for (const l of lineRows) {
      const lineId = l.id as string;
      const qtyOrdered = Number(l.qty_ordered ?? 0);
      if (qtyOrdered <= 0) {
        throw new Error(
          `Line ${lineId} has qty_ordered=${qtyOrdered}; must be > 0`
        );
      }
      const variantId = l.product_variant_id as string | null;
      const invItemId = l.inventory_item_id as string | null;
      const sku = l.sku_snapshot as string | null;
      const qbItemListId = l.qb_item_list_id_snapshot as string | null;
      if (!variantId || !invItemId || !sku) {
        throw new Error(
          `Line ${lineId} is missing variant/inventory/SKU snapshots`
        );
      }
      if (!qbItemListId) {
        throw new Error(
          `Line ${lineId} (${sku}) has no qb_item_list_id_snapshot; QB PurchaseOrderAdd cannot reference unsynced items`
        );
      }

      validated.push({
        line_id: lineId,
        product_variant_id: variantId,
        inventory_item_id: invItemId,
        sku,
        description: (l.description_snapshot as string) ?? sku,
        qb_item_list_id: qbItemListId,
        qty_ordered: qtyOrdered,
        unit_cost_cents: Number(l.unit_cost_cents ?? 0),
        total_cents: Number(l.total_cents ?? 0),
      });
    }

    // Resolve vendor via quickbooks-catalog module
    const qbCatalog = container.resolve(
      "quickbooks_catalog"
    ) as unknown as QbCatalogServiceLike;

    const vendorId = poRow.vendor_id as string;
    const vendor = await qbCatalog.retrieveQbVendor(vendorId);
    if (!vendor) {
      throw new Error(`Vendor ${vendorId} not found in qb_vendor`);
    }
    if (!vendor.qb_list_id) {
      throw new Error(
        `Vendor ${vendorId} (${vendor.full_name ?? vendor.name}) has no qb_list_id; resolve vendor in QuickBooks before submitting`
      );
    }

    return new StepResponse(
      {
        po: {
          id: poRow.id as string,
          vendor_id: vendorId,
          stock_location_id: poRow.stock_location_id as string,
          memo: (poRow.memo as string | null) ?? null,
          reference_number: (poRow.reference_number as string | null) ?? null,
          expected_at: (poRow.expected_at as Date | null) ?? null,
          ordered_at: (poRow.ordered_at as Date | null) ?? null,
          subtotal_cents: Number(poRow.subtotal_cents ?? 0),
          tax_cents: Number(poRow.tax_cents ?? 0),
          shipping_cents: Number(poRow.shipping_cents ?? 0),
          other_fees_cents: Number(poRow.other_fees_cents ?? 0),
          total_cents: Number(poRow.total_cents ?? 0),
        },
        vendor: {
          vendor_id: vendorId,
          vendor_name: vendor.full_name ?? vendor.name,
          vendor_qb_list_id: vendor.qb_list_id,
        },
        lines: validated,
      },
      null
    );
  }
);
