/**
 * Pre-apply snapshot — captures the full pre-write state for every product
 * and variant the plan will touch, so an --rollback run can restore it.
 *
 * Also captures existing variant↔qb_vendor links so link changes are reversible.
 */
import * as fs from "fs";
import * as path from "path";
import type { PayloadMap } from "./build-update-payload";

export type SnapshotRow = {
  productId: string;
  productMetadata: Record<string, unknown> | null;
  variants: Array<{
    id: string;
    metadata: Record<string, unknown> | null;
    vendorLinkIds: string[]; // qb_vendor.id values currently linked to this variant
  }>;
};

export type Snapshot = {
  generatedAt: string;
  planFile: string | null;
  rows: SnapshotRow[];
};

export function writeSnapshot(snapshot: Snapshot): string {
  const ts = Date.now();
  const file = path.join("/tmp", `qb-mass-sync-snapshot-${ts}.json`);
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2));
  return file;
}

export function readSnapshot(file: string): Snapshot {
  const raw = fs.readFileSync(file, "utf8");
  return JSON.parse(raw) as Snapshot;
}

export type SnapshotContext = {
  payloadMap: PayloadMap;
  variantById: Map<string, { id: string; productId: string; metadata: Record<string, unknown> | null }>;
  productById: Map<string, { id: string; metadata: Record<string, unknown> | null }>;
  variantVendorLinks: Map<string, string[]>; // variantId → [qb_vendor.id, ...]
  planFile: string | null;
};

export function buildSnapshot(ctx: SnapshotContext): Snapshot {
  const productIds = new Set<string>();
  for (const p of ctx.payloadMap.products.keys()) productIds.add(p);
  for (const v of ctx.payloadMap.variants.values()) productIds.add(v.productId);

  const rows: SnapshotRow[] = [];
  for (const productId of productIds) {
    const product = ctx.productById.get(productId);
    if (!product) continue;
    const siblings: SnapshotRow["variants"] = [];
    for (const variant of ctx.variantById.values()) {
      if (variant.productId !== productId) continue;
      siblings.push({
        id: variant.id,
        metadata: variant.metadata,
        vendorLinkIds: ctx.variantVendorLinks.get(variant.id) ?? [],
      });
    }
    rows.push({
      productId,
      productMetadata: product.metadata,
      variants: siblings,
    });
  }
  return {
    generatedAt: new Date().toISOString(),
    planFile: ctx.planFile,
    rows,
  };
}
