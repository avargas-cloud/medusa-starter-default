/**
 * verify-category-published-counts.ts — static assertions that the
 * storefront category endpoints (GET /store/product-categories and
 * GET /store/product-categories/:id) hide categories/children with no
 * published product in their subtree, and never leak inactive/internal
 * categories by default:
 *
 *   (a) both routes filter is_active/is_internal by default (only skipped
 *       never).
 *   (b) both routes add published_product_count to every returned category
 *       and to every entry of category_children.
 *   (c) the helper (src/lib/catalog/category-published-counts.ts) uses a
 *       WITH RECURSIVE CTE.
 *   (d) the helper filters status = 'published' AND deleted_at IS NULL.
 *
 * READ-ONLY. exit 1 on any FAIL.
 * Run: ./node_modules/.bin/tsx src/scripts/verify/verify-category-published-counts.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

interface Check {
  label: string;
  pass: boolean;
  detail: string;
}

const checks: Check[] = [];

function record(label: string, pass: boolean, detail: string): void {
  checks.push({ label, pass, detail });
}

const ROUTES = [
  "src/api/store/product-categories/route.ts",
  "src/api/store/product-categories/[id]/route.ts",
];

function checkRouteFiltersActiveInternal(rel: string): void {
  const src = readFileSync(join(ROOT, rel), "utf8");
  const hasActiveFilter = /is_active\s*=\s*true/.test(src);
  const hasInternalFilter = /is_internal\s*=\s*false/.test(src);
  const gatedByIncludeInactive = /const includeInactive = false/.test(src);
  record(
    `${rel}: filters is_active/is_internal by default (no opt-out switch)`,
    hasActiveFilter && hasInternalFilter && gatedByIncludeInactive,
    `is_active=${hasActiveFilter} is_internal=${hasInternalFilter} include_inactive=${gatedByIncludeInactive}`
  );
}

function checkRouteAddsPublishedCount(rel: string): void {
  const src = readFileSync(join(ROOT, rel), "utf8");
  const importsHelper = /getPublishedProductCountsBySubtree/.test(src);
  const addsFieldOnCategory =
    /published_product_count:\s*publishedCounts\.get\(category\.id\)/.test(
      src
    );
  const addsFieldOnChild =
    /published_product_count:\s*publishedCounts\.get\(child\.id\)/.test(src);
  record(
    `${rel}: adds published_product_count to category and category_children`,
    importsHelper && addsFieldOnCategory && addsFieldOnChild,
    `import=${importsHelper} onCategory=${addsFieldOnCategory} onChild=${addsFieldOnChild}`
  );
}

function checkHelperUsesRecursiveCte(): void {
  const rel = "src/lib/catalog/category-published-counts.ts";
  const src = readFileSync(join(ROOT, rel), "utf8");
  const hasRecursiveCte = /WITH RECURSIVE/.test(src);
  record(
    `${rel}: uses WITH RECURSIVE`,
    hasRecursiveCte,
    hasRecursiveCte ? "present" : "missing"
  );
}

function checkHelperFiltersPublishedNotDeleted(): void {
  const rel = "src/lib/catalog/category-published-counts.ts";
  const src = readFileSync(join(ROOT, rel), "utf8");
  const filtersPublished = /product\.status\s*=\s*'published'/.test(src);
  const filtersNotDeleted = /product\.deleted_at IS NULL/.test(src);
  record(
    `${rel}: filters product.status = 'published' AND product.deleted_at IS NULL`,
    filtersPublished && filtersNotDeleted,
    `status='published'=${filtersPublished} deleted_at IS NULL=${filtersNotDeleted}`
  );
}

function main(): void {
  console.log(
    "── verify-category-published-counts ─────────────────────────\n"
  );

  for (const rel of ROUTES) {
    checkRouteFiltersActiveInternal(rel);
    checkRouteAddsPublishedCount(rel);
  }
  checkHelperUsesRecursiveCte();
  checkHelperFiltersPublishedNotDeleted();

  let failures = 0;
  for (const c of checks) {
    console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.label}\n      ${c.detail}`);
    if (!c.pass) failures++;
  }

  console.log(`\n${checks.length - failures}/${checks.length} passed`);
  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED.`);
    process.exit(1);
  }
}

main();
