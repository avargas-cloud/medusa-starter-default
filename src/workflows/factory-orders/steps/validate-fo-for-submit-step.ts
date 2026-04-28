import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";

import { FACTORY_ORDERS_MODULE } from "../../../modules/factory-orders";
import type FactoryOrdersModuleService from "../../../modules/factory-orders/service";

export interface ValidateFoForSubmitStepInput {
  fo_id: string;
}

export interface ValidatedFoLine {
  line_id: string;
  product_variant_id: string;
  inventory_item_id: string;
  sku: string;
  description: string;
  qty_ordered: number;
  unit_cost_cents: number;
  total_cents: number;
}

export interface ValidateFoForSubmitStepOutput {
  fo: {
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
  vendor: {
    vendor_id: string;
    vendor_name: string;
    vendor_list_id: string | null;
  };
  lines: ValidatedFoLine[];
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

export const validateFoForSubmitStep = createStep(
  "validate-fo-for-submit",
  async (
    input: ValidateFoForSubmitStepInput,
    { container }
  ): Promise<StepResponse<ValidateFoForSubmitStepOutput, null>> => {
    const foService = container.resolve(
      FACTORY_ORDERS_MODULE
    ) as unknown as FactoryOrdersModuleService;

    const foRow = (await foService.retrieveFactoryOrder(
      input.fo_id
    )) as unknown as Record<string, unknown> | null;

    if (!foRow) {
      throw new Error(`Factory order ${input.fo_id} not found`);
    }

    const status = foRow.status as string;
    if (status !== "draft") {
      throw new Error(
        `Factory order ${input.fo_id} is ${status}; only drafts can be submitted`
      );
    }

    const lineRows = (await foService.listFactoryOrderLines(
      { factory_order_id: input.fo_id },
      { take: 1000 }
    )) as unknown as Array<Record<string, unknown>>;

    if (lineRows.length === 0) {
      throw new Error(
        `Factory order ${input.fo_id} has no lines; cannot submit`
      );
    }

    const validated: ValidatedFoLine[] = [];
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
      if (!variantId || !invItemId || !sku) {
        throw new Error(
          `Line ${lineId} is missing variant/inventory/SKU snapshots`
        );
      }
      validated.push({
        line_id: lineId,
        product_variant_id: variantId,
        inventory_item_id: invItemId,
        sku,
        description: (l.description_snapshot as string) ?? sku,
        qty_ordered: qtyOrdered,
        unit_cost_cents: Number(l.unit_cost_cents ?? 0),
        total_cents: Number(l.total_cents ?? 0),
      });
    }

    // Resolve vendor name from qb_vendor catalog (reused as factory vendor source)
    const qbCatalog = container.resolve(
      "quickbooks_catalog"
    ) as unknown as QbCatalogServiceLike;

    const vendorId = foRow.vendor_id as string;
    const vendor = await qbCatalog.retrieveQbVendor(vendorId).catch(() => null);
    const vendorName = vendor?.full_name ?? vendor?.name ?? vendorId;
    const vendorListId = vendor?.qb_list_id ?? null;

    return new StepResponse(
      {
        fo: {
          id: foRow.id as string,
          vendor_id: vendorId,
          stock_location_id: foRow.stock_location_id as string,
          memo: (foRow.memo as string | null) ?? null,
          reference_number: (foRow.reference_number as string | null) ?? null,
          expected_at: (foRow.expected_at as Date | null) ?? null,
          ordered_at: (foRow.ordered_at as Date | null) ?? null,
          subtotal_cents: Number(foRow.subtotal_cents ?? 0),
          tax_cents: Number(foRow.tax_cents ?? 0),
          shipping_cents: Number(foRow.shipping_cents ?? 0),
          other_fees_cents: Number(foRow.other_fees_cents ?? 0),
          total_cents: Number(foRow.total_cents ?? 0),
        },
        vendor: {
          vendor_id: vendorId,
          vendor_name: vendorName,
          vendor_list_id: vendorListId,
        },
        lines: validated,
      },
      null
    );
  }
);
