/**
 * Vendor link management for the mass metadata sync apply mode.
 *
 * For each variant that the sync touched, computes the target qb_vendor_id
 * (from variant override → product default), then reconciles the link table
 * `quickbooks_catalog_qb_vendor_product_product_variant` so each variant has
 * exactly one active link pointing at the right vendor (or none if QB has
 * no PrefVendor).
 */
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";
import type { MedusaContainer } from "@medusajs/framework/types";
import { QUICKBOOKS_CATALOG_MODULE } from "../../../modules/quickbooks-catalog";

const LINK_TABLE = "quickbooks_catalog_qb_vendor_product_product_variant";

export type VendorLinkPlan = {
  variantId: string;
  currentVendorIds: string[];
  targetVendorId: string | null; // qb_vendor.id (not qb_list_id)
  targetQbListId: string | null;
};

export type VendorLinkReport = {
  linksCreated: number;
  linksDismissed: number;
  skippedNoCatalogMatch: number;
  skippedNoTarget: number;
  missingVendors: Array<{ variantId: string; qbListId: string }>;
};

/**
 * Loads existing variant→qb_vendor links for the given variant ids.
 */
export async function loadExistingVendorLinks(
  container: MedusaContainer,
  variantIds: string[],
): Promise<Map<string, string[]>> {
  const knex = (container as unknown as { resolve: (k: string) => unknown }).resolve("__pg_connection__") as {
    raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: Array<{ product_variant_id: string; qb_vendor_id: string }> }>;
  };
  const byVariant = new Map<string, string[]>();
  if (variantIds.length === 0) return byVariant;
  const chunk = 500;
  for (let i = 0; i < variantIds.length; i += chunk) {
    const slice = variantIds.slice(i, i + chunk);
    const res = await knex.raw(
      `SELECT product_variant_id, qb_vendor_id
         FROM ${LINK_TABLE}
        WHERE deleted_at IS NULL
          AND product_variant_id = ANY(?::text[])`,
      [slice],
    );
    for (const row of res.rows) {
      const list = byVariant.get(row.product_variant_id) ?? [];
      list.push(row.qb_vendor_id);
      byVariant.set(row.product_variant_id, list);
    }
  }
  return byVariant;
}

/**
 * Loads the qb_vendor row ids indexed by qb_list_id.
 */
export async function loadVendorCatalog(
  container: MedusaContainer,
): Promise<Map<string, string>> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const { data } = await query.graph({
    entity: "qb_vendor",
    fields: ["id", "qb_list_id"],
    pagination: { skip: 0, take: 5000 },
  });
  const byListId = new Map<string, string>();
  for (const v of data as Array<{ id: string; qb_list_id: string | null }>) {
    if (v.qb_list_id) byListId.set(v.qb_list_id, v.id);
  }
  return byListId;
}

export type BuildPlanInput = {
  variantTargets: Array<{
    variantId: string;
    targetQbListId: string | null;
  }>;
  existingLinks: Map<string, string[]>;
  catalogByListId: Map<string, string>;
};

export function buildVendorLinkPlan(input: BuildPlanInput): {
  plan: VendorLinkPlan[];
  missing: Array<{ variantId: string; qbListId: string }>;
} {
  const plan: VendorLinkPlan[] = [];
  const missing: Array<{ variantId: string; qbListId: string }> = [];
  for (const t of input.variantTargets) {
    const current = input.existingLinks.get(t.variantId) ?? [];
    let targetVendorId: string | null = null;
    if (t.targetQbListId) {
      const resolved = input.catalogByListId.get(t.targetQbListId);
      if (!resolved) {
        missing.push({ variantId: t.variantId, qbListId: t.targetQbListId });
      } else {
        targetVendorId = resolved;
      }
    }
    plan.push({
      variantId: t.variantId,
      currentVendorIds: current,
      targetVendorId,
      targetQbListId: t.targetQbListId,
    });
  }
  return { plan, missing };
}

/**
 * Apply the plan: dismiss stale links, create new ones. Idempotent.
 */
export async function applyVendorLinkPlan(
  container: MedusaContainer,
  plan: VendorLinkPlan[],
  missing: Array<{ variantId: string; qbListId: string }>,
): Promise<VendorLinkReport> {
  const remoteLink = container.resolve(ContainerRegistrationKeys.LINK);
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const report: VendorLinkReport = {
    linksCreated: 0,
    linksDismissed: 0,
    skippedNoCatalogMatch: missing.length,
    skippedNoTarget: 0,
    missingVendors: missing,
  };

  for (const entry of plan) {
    const { variantId, currentVendorIds, targetVendorId } = entry;
    const currentSet = new Set(currentVendorIds);

    // Dismiss any link that is NOT the target.
    for (const vendorId of currentVendorIds) {
      if (targetVendorId && vendorId === targetVendorId) continue;
      try {
        await remoteLink.dismiss({
          [QUICKBOOKS_CATALOG_MODULE]: { qb_vendor_id: vendorId },
          [Modules.PRODUCT]: { product_variant_id: variantId },
        });
        report.linksDismissed++;
      } catch (err) {
        logger.warn(`[vendor-link] dismiss failed variant=${variantId} vendor=${vendorId}: ${String((err as Error).message)}`);
      }
    }

    if (!targetVendorId) {
      report.skippedNoTarget++;
      continue;
    }
    if (currentSet.has(targetVendorId)) {
      // Already linked.
      continue;
    }
    try {
      await remoteLink.create({
        [QUICKBOOKS_CATALOG_MODULE]: { qb_vendor_id: targetVendorId },
        [Modules.PRODUCT]: { product_variant_id: variantId },
      });
      report.linksCreated++;
    } catch (err) {
      const msg = String((err as Error).message ?? err);
      if (/duplicate|unique|already/i.test(msg)) continue;
      logger.warn(`[vendor-link] create failed variant=${variantId} vendor=${targetVendorId}: ${msg}`);
    }
  }
  return report;
}
