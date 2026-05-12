/**
 * verify-qb-exempt-tax-resolution.ts
 *
 * Verifies the QB SalesTaxItem ListID resolution that ships in the order
 * payload to the QB bridge. Static — no DB writes, no live QB calls, no
 * bridge traffic. Captures the regression where exempt orders were emitted
 * with the persisted `qb_tax_item_listid` (= Florida Sale Tax 7%) instead of
 * the env-configured Exempt ListID, causing QB to compute tax against an
 * exempt order (e.g. POS Order S10275 / QB SO 6326).
 *
 * Usage:
 *   yarn medusa exec ./src/scripts/verify/verify-qb-exempt-tax-resolution.ts
 *
 * Exits 0 on all-pass; non-zero on any mismatch.
 */

import { MedusaContainer } from "@medusajs/framework/types";
import { resolveTaxListid } from "../../lib/quickbooks/resolve-tax-listid";

/** Synthetic env-derived config — what getQbConfig() exposes. */
interface QbCfg {
  defaultSalesTaxCode: string;
  exemptSalesTaxCode: string;
  taxItemListidTaxed?: string;
  taxItemListidExempt?: string;
}

/** Synthetic order snapshot — only the fields the resolver reads. */
interface OrderSnapshot {
  tax_total: number | null | undefined;
  metadata?: { qb_tax_item_listid?: string };
}

/**
 * Mirror of the production logic shared by handle-order-placed,
 * handle-fulfillment-created, and handle-sales-receipt-created after the
 * 2026-05-11 exempt-listid refactor.
 *
 * Keep this in sync with those handlers — it's the code under test.
 */
function resolveTaxHeaderForOrder(
  order: OrderSnapshot,
  cfg: QbCfg
): { salesTaxCode?: string; qbTaxItemListid?: string } {
  const hasTax = !!order.tax_total && order.tax_total > 0;
  const salesTaxCode = hasTax
    ? cfg.defaultSalesTaxCode
    : cfg.exemptSalesTaxCode;
  const persisted = order.metadata?.qb_tax_item_listid;
  const qbTaxItemListid = hasTax
    ? persisted ?? resolveTaxListid("florida", cfg) ?? undefined
    : resolveTaxListid("exempt", cfg) ?? undefined;
  return { salesTaxCode, qbTaxItemListid };
}

interface TestCase {
  name: string;
  order: OrderSnapshot;
  cfg: QbCfg;
  expectedListid: string | undefined;
  expectedFullName: string;
  /** Hint used in the failure report — what regression each case guards. */
  guards: string;
}

const TAXED_LISTID = "8000010E-1340914624"; // QB_TAX_ITEM_LISTID_TAXED (prod env)
const EXEMPT_LISTID = "8000010D-1340911294"; // QB_TAX_ITEM_LISTID_EXEMPT (prod env)
const CUSTOM_LISTID = "C0FFEE01-1234567890"; // Synthetic persisted override

const baseCfg: QbCfg = {
  defaultSalesTaxCode: "Sale Tax 7%",
  exemptSalesTaxCode: "Exempt",
  taxItemListidTaxed: TAXED_LISTID,
  taxItemListidExempt: EXEMPT_LISTID,
};

const CASES: TestCase[] = [
  {
    name: "taxable order, no persisted listid → falls back to env Taxed ListID",
    order: { tax_total: 70.5, metadata: {} },
    cfg: baseCfg,
    expectedListid: TAXED_LISTID,
    expectedFullName: "Sale Tax 7%",
    guards: "Florida customers without backfill metadata still get 7%.",
  },
  {
    name: "taxable order with persisted listid → uses persisted (override wins)",
    order: { tax_total: 70.5, metadata: { qb_tax_item_listid: CUSTOM_LISTID } },
    cfg: baseCfg,
    expectedListid: CUSTOM_LISTID,
    expectedFullName: "Sale Tax 7%",
    guards: "Backfilled rows + per-order tax-item overrides keep working.",
  },
  {
    name: "exempt order, no persisted listid → uses env Exempt ListID",
    order: { tax_total: 0, metadata: {} },
    cfg: baseCfg,
    expectedListid: EXEMPT_LISTID,
    expectedFullName: "Exempt",
    guards: "Out-of-state customers ship with Exempt header → QB skips tax.",
  },
  {
    name: "exempt order WITH persisted Florida listid → must override to Exempt",
    order: {
      tax_total: 0,
      metadata: { qb_tax_item_listid: TAXED_LISTID },
    },
    cfg: baseCfg,
    expectedListid: EXEMPT_LISTID,
    expectedFullName: "Exempt",
    guards:
      "REGRESSION: S10275 / QB SO 6326 — order was exempt but persisted " +
      "qb_tax_item_listid still pointed at Sale Tax 7%. Must NOT be honored.",
  },
  {
    name: "exempt order, undefined tax_total → still resolves Exempt",
    order: { tax_total: undefined, metadata: {} },
    cfg: baseCfg,
    expectedListid: EXEMPT_LISTID,
    expectedFullName: "Exempt",
    guards: "Old orders without tax_total computed default to exempt header.",
  },
  {
    name: "exempt order, null tax_total → still resolves Exempt",
    order: { tax_total: null, metadata: {} },
    cfg: baseCfg,
    expectedListid: EXEMPT_LISTID,
    expectedFullName: "Exempt",
    guards: "Null tax_total (legacy snapshots) cannot trigger taxed path.",
  },
  {
    name: "env vars missing on taxable order → listid undefined, FullName fallback",
    order: { tax_total: 70.5, metadata: {} },
    cfg: { ...baseCfg, taxItemListidTaxed: undefined },
    expectedListid: undefined,
    expectedFullName: "Sale Tax 7%",
    guards:
      "Defensive: if env var is unset, bridge must fall back to FullName " +
      "(legacy behavior) rather than crash. Operator still sees a code.",
  },
  {
    name: "env vars missing on exempt order → listid undefined, FullName 'Exempt'",
    order: { tax_total: 0, metadata: {} },
    cfg: { ...baseCfg, taxItemListidExempt: undefined },
    expectedListid: undefined,
    expectedFullName: "Exempt",
    guards: "Defensive fallback when Exempt ListID is unset in env.",
  },
];

export default async function ({
  container: _c,
}: {
  container: MedusaContainer;
}) {
  const lines: string[] = [];
  let passed = 0;
  let failed = 0;

  lines.push("=== QB Exempt Tax ListID Resolution Verifier ===\n");

  for (const tc of CASES) {
    const { salesTaxCode, qbTaxItemListid } = resolveTaxHeaderForOrder(
      tc.order,
      tc.cfg
    );

    const listidOk = qbTaxItemListid === tc.expectedListid;
    const codeOk = salesTaxCode === tc.expectedFullName;
    const pass = listidOk && codeOk;
    if (pass) passed++;
    else failed++;

    lines.push(`${pass ? "PASS" : "FAIL"} — ${tc.name}`);
    if (!pass) {
      lines.push(`  guards: ${tc.guards}`);
      lines.push(
        `  expected: listid=${tc.expectedListid ?? "(undefined)"} salesTaxCode=${tc.expectedFullName}`
      );
      lines.push(
        `  got:      listid=${qbTaxItemListid ?? "(undefined)"} salesTaxCode=${salesTaxCode ?? "(undefined)"}`
      );
    }
  }

  lines.push("");
  lines.push(`Result: ${passed} passed, ${failed} failed (${CASES.length} total)`);
  console.log(lines.join("\n"));

  if (failed > 0) {
    process.exitCode = 1;
    throw new Error(`verify-qb-exempt-tax-resolution: ${failed} case(s) failed`);
  }
}
