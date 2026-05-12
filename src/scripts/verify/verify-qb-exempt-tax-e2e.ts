/**
 * verify-qb-exempt-tax-e2e.ts
 *
 * Sandbox E2E (shadow): pulls real orders from the sandbox DB via query.graph
 * and applies the same `salesTaxCode + qbTaxItemListid` resolution shipped in
 * the 5 handlers (handle-order-placed / handle-fulfillment-created /
 * handle-sales-receipt-created and their MOD siblings). Asserts the resolver
 * picks the right env ListID for each tax_mode.
 *
 * MUST be run against sandbox only (DATABASE_URL=...:5499/...). Read-only.
 *
 * Usage (from backend/):
 *   DATABASE_URL=postgresql://postgres:sandbox@localhost:5499/medusa \
 *   REDIS_URL=redis://localhost:6399 \
 *   QB_TAX_ITEM_LISTID_TAXED=8000010E-1340914624 \
 *   QB_TAX_ITEM_LISTID_EXEMPT=8000010D-1340911294 \
 *   QB_DEFAULT_SALES_TAX_CODE="Sale Tax 7%" \
 *   yarn medusa exec ./src/scripts/verify/verify-qb-exempt-tax-e2e.ts \
 *     [exempt_order_id] [taxable_order_id]
 */

import { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";
import { resolveTaxListid } from "../../lib/quickbooks/resolve-tax-listid";

const SAMPLE_EXEMPT_ORDER = "order_01KQD5B27P9H940ZR4Q07VM0GK";
const SAMPLE_TAXABLE_ORDER = "order_01KQDJ4DM0ZN3JZEJYCG29RJSN";

/** Mirror of the production header-tax resolution shared by all 3 handlers. */
function resolveHeader(
  order: { tax_total: number | null | undefined; metadata?: any },
  cfg: {
    defaultSalesTaxCode: string;
    exemptSalesTaxCode: string;
    taxItemListidTaxed?: string;
    taxItemListidExempt?: string;
  }
): { salesTaxCode?: string; qbTaxItemListid?: string } {
  const hasTax = !!order.tax_total && Number(order.tax_total) > 0;
  const salesTaxCode = hasTax
    ? cfg.defaultSalesTaxCode
    : cfg.exemptSalesTaxCode;
  const persisted = order.metadata?.qb_tax_item_listid as string | undefined;
  const qbTaxItemListid = hasTax
    ? persisted ?? resolveTaxListid("florida", cfg) ?? undefined
    : resolveTaxListid("exempt", cfg) ?? undefined;
  return { salesTaxCode, qbTaxItemListid };
}

export default async function ({
  container,
}: {
  container: MedusaContainer;
}) {
  const dbUrl = process.env.DATABASE_URL ?? "";
  if (!/:5499\//.test(dbUrl)) {
    throw new Error(
      `Refusing to run: DATABASE_URL must point to sandbox (port 5499). ` +
        `Got: ${dbUrl.replace(/:[^@/]+@/, ":***@")}`
    );
  }

  const cfg = {
    defaultSalesTaxCode: process.env.QB_DEFAULT_SALES_TAX_CODE ?? "Sale Tax 7%",
    exemptSalesTaxCode: process.env.QB_EXEMPT_SALES_TAX_CODE ?? "Exempt",
    taxItemListidTaxed: process.env.QB_TAX_ITEM_LISTID_TAXED,
    taxItemListidExempt: process.env.QB_TAX_ITEM_LISTID_EXEMPT,
  };
  if (!cfg.taxItemListidTaxed || !cfg.taxItemListidExempt) {
    throw new Error(
      "QB_TAX_ITEM_LISTID_TAXED and QB_TAX_ITEM_LISTID_EXEMPT must be set."
    );
  }

  // medusa exec injects its own argv noise; keep only entries that look like
  // a Medusa order id (prefix `order_`). Defaults to sandbox sample IDs.
  const orderArgs = process.argv.filter((a) => a.startsWith("order_"));
  const exemptId = orderArgs[0] ?? SAMPLE_EXEMPT_ORDER;
  const taxableId = orderArgs[1] ?? SAMPLE_TAXABLE_ORDER;

  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);

  async function fetchOrder(orderId: string) {
    const {
      data: [order],
    } = await (query as any).graph({
      entity: "order",
      fields: ["id", "display_id", "tax_total", "metadata"],
      filters: { id: orderId },
    });
    if (!order) throw new Error(`Order ${orderId} not found in sandbox`);
    return order as { id: string; display_id: number; tax_total: number | null; metadata: any };
  }

  const report: string[] = ["=== QB Exempt Tax E2E shadow (sandbox) ==="];
  let passed = 0;
  let failed = 0;

  // --- Case 1: exempt order ---
  try {
    const o = await fetchOrder(exemptId);
    const got = resolveHeader(o, cfg);
    const taxModeReported = o.metadata?.tax_mode ?? "(unset)";
    logger.info(
      `[verify-e2e] EXEMPT: S${o.display_id} tax_mode=${taxModeReported} ` +
        `tax_total=${o.tax_total ?? "null"} persisted_listid=${o.metadata?.qb_tax_item_listid ?? "(none)"}`
    );
    report.push(
      `EXEMPT S${o.display_id} (tax_mode=${taxModeReported}): salesTaxCode=${got.salesTaxCode} qbTaxItemListid=${got.qbTaxItemListid}`
    );
    if (got.qbTaxItemListid === cfg.taxItemListidExempt) {
      report.push(`  PASS — Exempt ListID resolved (${cfg.taxItemListidExempt})`);
      passed++;
    } else {
      report.push(
        `  FAIL — expected ${cfg.taxItemListidExempt}, got ${got.qbTaxItemListid}`
      );
      failed++;
    }
  } catch (err: any) {
    report.push(`EXEMPT: ERROR — ${err.message}`);
    failed++;
  }

  // --- Case 2: taxable order ---
  try {
    const o = await fetchOrder(taxableId);
    const got = resolveHeader(o, cfg);
    const taxModeReported = o.metadata?.tax_mode ?? "(unset)";
    logger.info(
      `[verify-e2e] TAXABLE: S${o.display_id} tax_mode=${taxModeReported} ` +
        `tax_total=${o.tax_total ?? "null"} persisted_listid=${o.metadata?.qb_tax_item_listid ?? "(none)"}`
    );
    report.push(
      `TAXABLE S${o.display_id} (tax_mode=${taxModeReported}): salesTaxCode=${got.salesTaxCode} qbTaxItemListid=${got.qbTaxItemListid}`
    );
    if (got.qbTaxItemListid === cfg.taxItemListidTaxed) {
      report.push(`  PASS — Taxed ListID resolved (${cfg.taxItemListidTaxed})`);
      passed++;
    } else if (got.qbTaxItemListid === o.metadata?.qb_tax_item_listid) {
      report.push(
        `  PASS — persisted ListID honored (${got.qbTaxItemListid})`
      );
      passed++;
    } else {
      report.push(
        `  FAIL — expected ${cfg.taxItemListidTaxed} or persisted, got ${got.qbTaxItemListid}`
      );
      failed++;
    }
  } catch (err: any) {
    report.push(`TAXABLE: ERROR — ${err.message}`);
    failed++;
  }

  // --- Case 3: regression — synthetic exempt order with persisted Florida listid ---
  try {
    const o = await fetchOrder(exemptId);
    const synthetic = {
      ...o,
      metadata: {
        ...(o.metadata ?? {}),
        qb_tax_item_listid: cfg.taxItemListidTaxed, // poison: persisted Florida
      },
    };
    const got = resolveHeader(synthetic, cfg);
    report.push(
      `REGRESSION exempt+persistedFlorida (S${o.display_id}): qbTaxItemListid=${got.qbTaxItemListid}`
    );
    if (got.qbTaxItemListid === cfg.taxItemListidExempt) {
      report.push(
        `  PASS — exempt ListID still wins over poisoned persisted value`
      );
      passed++;
    } else {
      report.push(
        `  FAIL — expected ${cfg.taxItemListidExempt} (Exempt), got ${got.qbTaxItemListid}`
      );
      failed++;
    }
  } catch (err: any) {
    report.push(`REGRESSION: ERROR — ${err.message}`);
    failed++;
  }

  report.push("");
  report.push(`Result: ${passed} passed, ${failed} failed`);
  console.log(report.join("\n"));

  if (failed > 0) {
    process.exitCode = 1;
    throw new Error(`verify-qb-exempt-tax-e2e: ${failed} case(s) failed`);
  }
}
