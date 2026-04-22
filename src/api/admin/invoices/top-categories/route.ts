/**
 * GET /admin/invoices/top-categories
 * Returns qty + revenue aggregated by product category for a date range.
 * Dynamically resolves all child categories of "BY CATEGORIES".
 * Only categories with actual sales are returned.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Modules } from "@medusajs/utils";
import { INVOICE_MODULE } from "../../../../modules/invoices";

interface CategoryResult {
  name: string;
  qty: number;
  revenue: number;
}

interface InvItem {
  variant_id?: string | null;
  sku?: string | null;
  is_comment?: boolean;
  unit_price?: number;
  quantity?: number;
  total?: number;
  metadata?: { is_comment?: boolean };
}

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const { from, to } = req.query as Record<string, string>;

  if (!from || !to) {
    res.status(400).json({ error: "from and to query params are required" });
    return;
  }

  const invoiceService = req.scope.resolve(INVOICE_MODULE);
  const productModule = req.scope.resolve(Modules.PRODUCT) as any;

  // 1. Fetch invoices in date range (active statuses only)
  const invoices = await invoiceService.listPosInvoices(
    {
      created_at: { $gte: from, $lte: to },
      status: ["issued", "partial", "paid"],
    },
    { relations: ["items"], take: 500 }
  );

  // 2. Collect all variant_ids from non-comment line items
  const variantIds = new Set<string>();
  for (const inv of invoices) {
    for (const item of (inv.items ?? []) as InvItem[]) {
      if (item.is_comment || item.metadata?.is_comment) continue;
      if (
        !item.variant_id &&
        !item.sku &&
        (!item.unit_price || item.unit_price === 0)
      )
        continue;
      if (item.variant_id) variantIds.add(item.variant_id);
    }
  }

  // 3. Resolve all child categories of "BY CATEGORIES" dynamically
  const categoryIdToName = new Map<string, string>();
  try {
    const allCategories = await productModule.listProductCategories(
      {},
      { select: ["id", "name", "handle", "parent_category_id"] }
    );

    // Find the "BY CATEGORIES" parent by handle or name
    const parent = allCategories.find(
      (c: any) =>
        c.handle === "by-categories" ||
        c.name?.toUpperCase() === "BY CATEGORIES"
    );

    if (parent) {
      for (const cat of allCategories) {
        if (cat.parent_category_id === parent.id) {
          categoryIdToName.set(cat.id, cat.name);
        }
      }
    } else {
      // Fallback: use all top-level categories (no parent)
      for (const cat of allCategories) {
        if (!cat.parent_category_id) {
          categoryIdToName.set(cat.id, cat.name);
        }
      }
    }
  } catch {
    // If category lookup fails, return empty
    res.json({ categories: [] });
    return;
  }

  // 4. Map variant_id → category name via product module
  const variantToCategoryName = new Map<string, string>();
  if (variantIds.size > 0) {
    try {
      const variants = await productModule.listProductVariants(
        { id: Array.from(variantIds) },
        { relations: ["product", "product.categories"] }
      );
      for (const variant of variants) {
        const cats: { id: string; name: string }[] =
          variant.product?.categories ?? [];
        const match = cats.find((c) => categoryIdToName.has(c.id));
        if (match) variantToCategoryName.set(variant.id, categoryIdToName.get(match.id)!);
      }
    } catch {
      // Silent — return what we have
    }
  }

  // 5. Aggregate qty + revenue per category
  const acc = new Map<string, CategoryResult>();

  for (const inv of invoices) {
    for (const item of (inv.items ?? []) as InvItem[]) {
      if (item.is_comment || item.metadata?.is_comment) continue;
      if (
        !item.variant_id &&
        !item.sku &&
        (!item.unit_price || item.unit_price === 0)
      )
        continue;
      if (!item.variant_id) continue;

      const catName = variantToCategoryName.get(item.variant_id);
      if (!catName) continue;

      const entry = acc.get(catName) ?? { name: catName, qty: 0, revenue: 0 };
      entry.qty += item.quantity ?? 0;
      entry.revenue +=
        (item.total ?? (item.unit_price ?? 0) * (item.quantity ?? 0)) / 100;
      acc.set(catName, entry);
    }
  }

  const categories = Array.from(acc.values());
  res.json({ categories });
}
