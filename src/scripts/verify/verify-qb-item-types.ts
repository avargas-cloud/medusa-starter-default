/**
 * Verify QB item-type metadata coverage across Medusa products.
 *
 * Purpose:
 *   The QB Sales Order / Estimate / Invoice builder (`buildQbItems` in
 *   `lib/quickbooks/order-flow-core.ts`) emits `InventorySiteRef` (Site) on
 *   every line by default. Lines for QB Service / NonInventory / OtherCharge /
 *   Discount / Subtotal / Payment / SalesTax items MUST NOT carry a Site or
 *   QB rejects the whole document with Error 3140
 *   ("invalid reference to ... Site"). That suppression is keyed on:
 *
 *     - `variant.metadata.quickbooks_is_service` / `quickbooks_no_site`, OR
 *     - `variant.metadata.qb_item_type` / `product.metadata.qb_item_type`
 *       set to a value in NON_SITE_QB_ITEM_TYPES.
 *
 *   If a product is a Service in QB but neither flag is set in Medusa, the
 *   builder will emit Site → QB returns 3140 → pipeline retries indefinitely.
 *   That is exactly what bit SO 1700 (`Services:Assembly-Panels`) for 8 days.
 *
 * What this script does:
 *   - Reads every Medusa variant with `metadata.quickbooks_id` set.
 *   - Replays the same `isNoSiteItem` boolean the builder computes.
 *   - Buckets variants by classification, lists suspicious cases
 *     (no qb_item_type, no variant flag, name suggests Service).
 *
 * Run:
 *   ./node_modules/.bin/medusa exec ./src/scripts/verify/verify-qb-item-types.ts
 *   ./node_modules/.bin/medusa exec ./src/scripts/verify/verify-qb-item-types.ts -- --suspicious-only
 */
import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";

const NON_SITE_QB_ITEM_TYPES = new Set([
  "Service",
  "NonInventory",
  "NonInventoryPart",
  "OtherCharge",
  "Discount",
  "Subtotal",
  "Payment",
  "SalesTax",
]);

// Word-boundary regex — avoids false positives like "feet" matching "fee" or
// "channel" being unrelated to "charge". Patterns target whole tokens that
// usually denote QB Service / NonInventory items in EcoPowerTech's catalog.
const NAME_SUGGESTS_NON_SITE = /\b(service|services|install|installation|labor|delivery|assembly|expedite|photometric|on[- ]site|deposit|discount|warranty|surcharge|handling[- ]fee|restocking[- ]fee)\b/i;

interface VariantRow {
  product_id: string;
  product_title: string | null;
  product_handle: string | null;
  product_metadata: Record<string, unknown> | null;
  variant_id: string;
  variant_sku: string | null;
  variant_metadata: Record<string, unknown> | null;
}

interface ClassifiedRow extends VariantRow {
  quickbooks_id: string;
  resolved_qb_item_type: string | null;
  variant_is_service: boolean;
  variant_no_site: boolean;
  would_emit_no_site: boolean;
  effective_classification: "non-site" | "site (inventory)";
  suspicion: string | null;
}

function asString(v: unknown): string | null {
  if (v == null) return null;
  return String(v);
}

function asBoolFlag(v: unknown): boolean {
  return v === true || v === "true";
}

function classify(row: VariantRow): ClassifiedRow | null {
  const variantMeta = row.variant_metadata ?? {};
  const productMeta = row.product_metadata ?? {};
  const quickbooksId = asString(variantMeta.quickbooks_id);
  if (!quickbooksId) return null;

  const variantQbType = asString(variantMeta.qb_item_type);
  const productQbType = asString(productMeta.qb_item_type);
  const resolvedQbType = variantQbType ?? productQbType;

  const variantIsService =
    asBoolFlag(variantMeta.quickbooks_is_service) ||
    asBoolFlag(productMeta.quickbooks_is_service);
  const variantNoSite =
    asBoolFlag(variantMeta.quickbooks_no_site) ||
    asBoolFlag(productMeta.quickbooks_no_site);

  const wouldEmitNoSite =
    variantIsService ||
    variantNoSite ||
    (resolvedQbType !== null && NON_SITE_QB_ITEM_TYPES.has(resolvedQbType));

  const title = row.product_title ?? "";
  const sku = row.variant_sku ?? "";
  const nameLikelyNonSite =
    NAME_SUGGESTS_NON_SITE.test(title) || NAME_SUGGESTS_NON_SITE.test(sku);

  let suspicion: string | null = null;
  if (nameLikelyNonSite && !wouldEmitNoSite) {
    suspicion =
      "name suggests Service/NonInventory but no flag set — builder will emit Site → risk of QB Error 3140";
  } else if (resolvedQbType && !NON_SITE_QB_ITEM_TYPES.has(resolvedQbType) && resolvedQbType !== "Inventory") {
    suspicion = `qb_item_type='${resolvedQbType}' is not a known type — verify against QB`;
  } else if (!resolvedQbType && !variantIsService && !variantNoSite) {
    suspicion =
      "no qb_item_type metadata anywhere — builder defaults to Site (Inventory). Verify against QB before this variant is included in an order";
  }

  return {
    ...row,
    quickbooks_id: quickbooksId,
    resolved_qb_item_type: resolvedQbType,
    variant_is_service: variantIsService,
    variant_no_site: variantNoSite,
    would_emit_no_site: wouldEmitNoSite,
    effective_classification: wouldEmitNoSite ? "non-site" : "site (inventory)",
    suspicion,
  };
}

export default async function verifyQbItemTypes({
  container,
  args,
}: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const pg: any = container.resolve("__pg_connection__");

  const suspiciousOnly = (args ?? []).includes("--suspicious-only");

  const sql = `
    SELECT p.id AS product_id,
           p.title AS product_title,
           p.handle AS product_handle,
           p.metadata AS product_metadata,
           v.id AS variant_id,
           v.sku AS variant_sku,
           v.metadata AS variant_metadata
      FROM product p
      JOIN product_variant v ON v.product_id = p.id
     WHERE v.metadata ? 'quickbooks_id'
       AND v.deleted_at IS NULL
       AND p.deleted_at IS NULL
     ORDER BY p.title NULLS LAST, v.sku NULLS LAST
  `;
  const { rows } = await pg.raw(sql);
  const variantRows = rows as VariantRow[];

  const classified: ClassifiedRow[] = [];
  for (const r of variantRows) {
    const c = classify(r);
    if (c) classified.push(c);
  }

  const stats = {
    total: classified.length,
    non_site: 0,
    site: 0,
    suspicious: 0,
    by_qb_item_type: new Map<string, number>(),
  };
  for (const c of classified) {
    if (c.would_emit_no_site) stats.non_site++;
    else stats.site++;
    if (c.suspicion) stats.suspicious++;
    const key = c.resolved_qb_item_type ?? "(none)";
    stats.by_qb_item_type.set(key, (stats.by_qb_item_type.get(key) ?? 0) + 1);
  }

  logger.info(`[verify-qb-item-types] Total QB-linked variants: ${stats.total}`);
  logger.info(`[verify-qb-item-types]   would emit noSite (Service/NonInventory/etc): ${stats.non_site}`);
  logger.info(`[verify-qb-item-types]   would emit Site (Inventory): ${stats.site}`);
  logger.info(`[verify-qb-item-types]   SUSPICIOUS (likely missing metadata): ${stats.suspicious}`);

  const breakdown = Array.from(stats.by_qb_item_type.entries()).sort(
    (a, b) => b[1] - a[1]
  );
  logger.info(`[verify-qb-item-types] Resolved qb_item_type distribution:`);
  for (const [k, v] of breakdown) {
    logger.info(`[verify-qb-item-types]   ${k}: ${v}`);
  }

  const toReport = suspiciousOnly
    ? classified.filter((c) => c.suspicion)
    : classified;

  if (toReport.length === 0) {
    logger.info("[verify-qb-item-types] No rows to report.");
    return;
  }

  const HEADER = [
    "product_id",
    "product_title",
    "variant_sku",
    "quickbooks_id",
    "resolved_qb_item_type",
    "variant_is_service",
    "variant_no_site",
    "effective_classification",
    "suspicion",
  ].join("\t");
  console.log(HEADER);
  for (const c of toReport) {
    const line = [
      c.product_id,
      (c.product_title ?? "").replace(/\t/g, " "),
      c.variant_sku ?? "",
      c.quickbooks_id,
      c.resolved_qb_item_type ?? "",
      c.variant_is_service ? "yes" : "",
      c.variant_no_site ? "yes" : "",
      c.effective_classification,
      c.suspicion ?? "",
    ].join("\t");
    console.log(line);
  }

  if (stats.suspicious > 0) {
    logger.warn(
      `[verify-qb-item-types] ⚠️  ${stats.suspicious} suspicious row(s) — review and backfill product.metadata.qb_item_type (or variant.metadata.quickbooks_is_service) before they break a pipeline run.`
    );
  } else {
    logger.info(
      `[verify-qb-item-types] ✅ No suspicious rows. Every variant linked to QB has either a recognized qb_item_type or a no-site flag, or its name does not suggest a non-Site classification.`
    );
  }
}
