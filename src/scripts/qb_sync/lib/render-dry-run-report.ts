/**
 * Renders the mass-metadata-sync plan as a human-readable terminal report
 * and returns the structured JSON plan for persistence.
 */
import type { Classification, ProductFieldDiff, VariantFieldDiff } from "./classify-metadata-diff";

export type PerVariantEntry = {
  listId: string;
  variantId: string;
  productId: string;
  sku: string;
  classification: Classification;
  isDriver: boolean;
  productDiffs: ProductFieldDiff[];
  variantDiffs: VariantFieldDiff[];
};

export type OrphanEntry = {
  variantId: string;
  productId: string;
  sku: string | null;
  listId: string;
};

export type MissingEntry = {
  listId: string;
  sku: string;
  itemType: string;
};

export type DryRunPlan = {
  generatedAt: string;
  bridgeOperationId: string;
  totals: {
    qbItemsFetched: number;
    medusaVariantsWithQbId: number;
    matched: number;
    byClassification: Record<Classification, number>;
    orphans: number;
    missing: number;
    productsTouched: number;
    variantsTouched: number;
  };
  entries: PerVariantEntry[];
  orphans: OrphanEntry[];
  missing: MissingEntry[];
};

function truncate(s: string, n: number): string {
  if (s.length <= n) return s.padEnd(n);
  return s.slice(0, n - 1) + "…";
}

function renderDiffValue(v: unknown): string {
  if (v === null) return "∅";
  if (v === undefined) return "—";
  if (typeof v === "string") return v.length > 24 ? v.slice(0, 23) + "…" : v;
  return String(v);
}

export function renderDryRunReport(plan: DryRunPlan): void {
  const byProduct = new Map<string, PerVariantEntry[]>();
  for (const e of plan.entries) {
    const list = byProduct.get(e.productId) ?? [];
    list.push(e);
    byProduct.set(e.productId, list);
  }

  const changedGroups = Array.from(byProduct.entries()).filter(([, entries]) =>
    entries.some((e) => e.classification !== "NO_CHANGE"),
  );

  console.log();
  console.log("═".repeat(100));
  console.log(`  MASS METADATA SYNC — DRY RUN PLAN`);
  console.log(`  Generated: ${plan.generatedAt}`);
  console.log(`  Bridge operation: ${plan.bridgeOperationId}`);
  console.log("═".repeat(100));
  console.log();

  for (const [productId, entries] of changedGroups) {
    entries.sort((a, b) => a.variantId.localeCompare(b.variantId));
    console.log(`── Product ${productId} ── (${entries.length} variant${entries.length === 1 ? "" : "s"})`);
    const driver = entries.find((e) => e.isDriver);
    if (driver && driver.productDiffs.length > 0) {
      console.log(`   PRODUCT.metadata changes (from driver ${driver.variantId}):`);
      for (const d of driver.productDiffs) {
        console.log(`     ${truncate(d.key, 34)}  ${renderDiffValue(d.oldValue)}  →  ${renderDiffValue(d.newValue)}`);
      }
    }
    for (const e of entries) {
      if (e.classification === "NO_CHANGE") continue;
      const tag = e.isDriver ? "★" : " ";
      console.log(`   ${tag} ${truncate(e.sku, 26)}  [${e.classification}]`);
      for (const d of e.variantDiffs) {
        const marker = d.clearing ? "✗" : "·";
        console.log(
          `       ${marker} ${truncate(d.key, 32)}  ${renderDiffValue(d.oldValue)}  →  ${renderDiffValue(d.newValue)}`,
        );
      }
    }
    console.log();
  }

  if (plan.orphans.length > 0) {
    console.log(`── ORPHANS (Medusa has quickbooks_id, QB did not return) ── ${plan.orphans.length}`);
    for (const o of plan.orphans.slice(0, 50)) {
      console.log(`   ${truncate(o.sku ?? "(no sku)", 30)}  variant=${o.variantId}  listId=${o.listId}`);
    }
    if (plan.orphans.length > 50) console.log(`   … and ${plan.orphans.length - 50} more`);
    console.log();
  }

  if (plan.missing.length > 0) {
    console.log(`── MISSING (QB has item, Medusa does not) ── ${plan.missing.length}`);
    for (const m of plan.missing.slice(0, 50)) {
      console.log(`   ${truncate(m.sku, 30)}  listId=${m.listId}  type=${m.itemType}`);
    }
    if (plan.missing.length > 50) console.log(`   … and ${plan.missing.length - 50} more`);
    console.log();
  }

  console.log("═".repeat(100));
  console.log(`  TOTALS`);
  console.log("═".repeat(100));
  console.log(`  QB items fetched:           ${plan.totals.qbItemsFetched}`);
  console.log(`  Medusa variants w/ QB ID:   ${plan.totals.medusaVariantsWithQbId}`);
  console.log(`  Matched:                    ${plan.totals.matched}`);
  console.log(`  Orphans (Medusa only):      ${plan.totals.orphans}`);
  console.log(`  Missing (QB only):          ${plan.totals.missing}`);
  console.log(`  Products touched:           ${plan.totals.productsTouched}`);
  console.log(`  Variants touched:           ${plan.totals.variantsTouched}`);
  console.log(`  By classification:`);
  for (const [cls, n] of Object.entries(plan.totals.byClassification)) {
    if (n > 0) console.log(`    ${cls.padEnd(28)} ${n}`);
  }
  console.log("═".repeat(100));
  console.log();
}
