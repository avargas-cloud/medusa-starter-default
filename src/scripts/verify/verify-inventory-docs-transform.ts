/**
 * verify-inventory-docs-transform.ts
 *
 * F1.2 verification. Runs the pure `buildInventoryDocsForVariants` transform
 * against synthetic Medusa variant graphs and asserts the MeiliSearch docs
 * match expectations. No network, no DB.
 *
 * Usage:
 *   cd backend
 *   npx tsx src/scripts/verify/verify-inventory-docs-transform.ts
 */

import { readFileSync } from "fs";
import { resolve as resolvePath } from "path";

import {
  buildInventoryDocsForVariants,
  type MeiliInventoryDoc,
} from "../../lib/meilisearch/build-inventory-docs";

interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}
const checks: Check[] = [];

function add(name: string, pass: boolean, detail?: string) {
  checks.push({ name, pass, detail });
}

// ---------- Scenario 1: variant with 1 inventory_item, 1 price list ----------
{
  const pricesByPriceSet = new Map<string, Record<string, number>>([
    ["pset_A", { plist_whole: 25 }],
  ]);
  const variants = [
    {
      id: "variant_A",
      sku: "SKU-A",
      metadata: {
        sales_description: "A nice description",
        qb_purchase_cost: 10,
        qb_vendor_name: "VendorCo",
      },
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
      price_set: { id: "pset_A" },
      product: {
        id: "prod_1",
        title: "Product One",
        handle: "product-one",
        thumbnail: "https://cdn.example.com/a.jpg",
        status: "published",
        metadata: {},
        categories: [
          {
            handle: "lights",
            parent_category: { handle: "electrical", parent_category: null },
          },
        ],
      },
      prices: [
        { amount: 42, currency_code: "usd", price_list_id: null },
        { amount: 100, currency_code: "eur", price_list_id: null },
      ],
      inventory_items: [
        {
          inventory: {
            id: "iitem_A",
            sku: "SKU-A",
            title: "SKU-A Item",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-03T00:00:00Z",
            stocked_quantity: 17,
            reserved_quantity: 3,
          },
        },
      ],
      options: [{ option: { title: "Color" }, value: "Red" }],
    },
  ];

  const docs = buildInventoryDocsForVariants(variants, pricesByPriceSet);
  add("scenario 1 — exactly one doc produced", docs.length === 1);
  const d = docs[0]!;
  add("scenario 1 — id = inventory_item.id", d.id === "iitem_A");
  add("scenario 1 — variantId and productId set", d.variantId === "variant_A" && d.productId === "prod_1");
  add(
    "scenario 1 — picks USD price only (42), ignores EUR",
    d.price === 42 && d.currencyCode === "USD"
  );
  add(
    "scenario 1 — stock/reserved mapped",
    d.totalStock === 17 && d.totalReserved === 3
  );
  add(
    "scenario 1 — pricesByList pulled from map",
    d.pricesByList["plist_whole"] === 25
  );
  add(
    "scenario 1 — category + parent flattened",
    d.category_handles.includes("lights") &&
      d.category_handles.includes("electrical")
  );
  add(
    "scenario 1 — options mapped",
    d.options.length === 1 &&
      d.options[0]!.title === "Color" &&
      d.options[0]!.value === "Red"
  );
  add(
    "scenario 1 — variant metadata surfaced",
    d.salesDescription === "A nice description" &&
      d.cost === 10 &&
      d.vendorName === "VendorCo"
  );
  add(
    "scenario 1 — updated_at uses inventory.updated_at",
    d.updated_at === new Date("2026-01-03T00:00:00Z").getTime()
  );
}

// ---------- Scenario 2: variant WITHOUT inventory_items (service) ----------
{
  const variants = [
    {
      id: "variant_S",
      sku: "INSTALL-FEE",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-05T00:00:00Z",
      product: { id: "prod_s", title: "Install Fee", handle: "install-fee", status: "published" },
      prices: [{ amount: 50, currency_code: "usd" }],
      inventory_items: [],
      options: [],
    },
  ];
  const docs = buildInventoryDocsForVariants(variants);
  add("scenario 2 (synthetic) — one doc produced", docs.length === 1);
  add("scenario 2 — id falls back to variant.id", docs[0]!.id === "variant_S");
  add("scenario 2 — totalStock is null for service", docs[0]!.totalStock === null);
  add("scenario 2 — price 50 USD", docs[0]!.price === 50 && docs[0]!.currencyCode === "USD");
}

// ---------- Scenario 3: variant without SKU AND no inventory → skipped ----------
{
  const variants = [
    {
      id: "variant_skip",
      sku: null,
      product: { id: "prod_skip", title: "x" },
      prices: [],
      inventory_items: [],
      options: [],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    },
  ];
  const docs = buildInventoryDocsForVariants(variants);
  add("scenario 3 — synthetic with no sku is skipped (no doc)", docs.length === 0);
}

// ---------- Scenario 4: variant with multiple inventory_items → multiple docs ----------
{
  const variants = [
    {
      id: "variant_multi",
      sku: "SKU-MULTI",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      product: { id: "prod_multi", title: "Multi", status: "published" },
      prices: [{ amount: 10, currency_code: "usd" }],
      inventory_items: [
        {
          inventory: {
            id: "iitem_1",
            sku: "SKU-1",
            stocked_quantity: 5,
            reserved_quantity: 0,
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        },
        {
          inventory: {
            id: "iitem_2",
            sku: "SKU-2",
            stocked_quantity: 8,
            reserved_quantity: 1,
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        },
      ],
      options: [],
    },
  ];
  const docs = buildInventoryDocsForVariants(variants);
  add("scenario 4 — two docs produced", docs.length === 2);
  const ids = docs.map((d) => d.id).sort();
  add(
    "scenario 4 — ids are both inventory_item ids",
    ids[0] === "iitem_1" && ids[1] === "iitem_2"
  );
  add(
    "scenario 4 — stocks mapped per item",
    docs.find((d) => d.id === "iitem_1")!.totalStock === 5 &&
      docs.find((d) => d.id === "iitem_2")!.totalStock === 8
  );
}

// ---------- Scenario 5: retail price picks the MAX when multiple USD ----------
{
  const variants = [
    {
      id: "variant_max",
      sku: "MAX",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      product: { id: "prod_max", title: "Max", status: "published" },
      prices: [
        { amount: 10, currency_code: "usd" },
        { amount: 42, currency_code: "usd" },
        { amount: 20, currency_code: "usd" },
      ],
      inventory_items: [
        {
          inventory: {
            id: "iitem_max",
            stocked_quantity: 0,
            reserved_quantity: 0,
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        },
      ],
      options: [],
    },
  ];
  const docs = buildInventoryDocsForVariants(variants);
  add("scenario 5 — retail price picks max (42)", docs[0]!.price === 42);
}

// ---------- Scenario 6: built workflow imports the correct shared transform ----------
{
  const wfPath = resolvePath(
    __dirname,
    "../../workflows/sync-inventory-item-meilisearch.ts"
  );
  const src = readFileSync(wfPath, "utf8");
  add(
    "scenario 6 — workflow imports buildInventoryDocsForVariants",
    /buildInventoryDocsForVariants[\s\S]*INVENTORY_DOC_FIELDS/.test(src)
  );
  add(
    "scenario 6 — workflow accepts productId/variantId/inventoryItemId scope",
    /productId\?\s*:\s*string/.test(src) &&
      /variantId\?\s*:\s*string/.test(src) &&
      /inventoryItemId\?\s*:\s*string/.test(src)
  );
  add(
    "scenario 6 — workflow handles delete via deleteWhenMissing",
    /deleteWhenMissing/.test(src) && /deleteDocument|deleteDocuments/.test(src)
  );
  add(
    "scenario 6 — workflow calls addDocuments with primaryKey: 'id'",
    /addDocuments\([^)]*primaryKey:\s*"id"/.test(src)
  );
}

// ---------- Scenario 7: product workflow cascades to inventory ----------
{
  const prodWfPath = resolvePath(
    __dirname,
    "../../workflows/sync-product-meilisearch.ts"
  );
  const src = readFileSync(prodWfPath, "utf8");
  add(
    "scenario 7 — product workflow imports the inventory cascade",
    /syncInventoryItemToMeiliSearchWorkflow/.test(src)
  );
  add(
    "scenario 7 — product workflow runs inventory cascade as step",
    /syncInventoryItemToMeiliSearchWorkflow\.runAsStep[\s\S]*productId/.test(
      src
    )
  );
}

// Render report.
console.log("━".repeat(60));
console.log("  F1.2 Inventory Docs Transform + Workflow — verification");
console.log("━".repeat(60));
let failed = 0;
for (const c of checks) {
  const glyph = c.pass ? "✅" : "❌";
  console.log(`${glyph}  ${c.name}`);
  if (!c.pass && c.detail) console.log(`    ${c.detail}`);
  if (!c.pass) failed++;
}
console.log("━".repeat(60));
if (failed === 0) {
  console.log(`✅ ALL ${checks.length} CHECKS PASSED`);
  process.exit(0);
}
console.log(`❌ ${failed} / ${checks.length} CHECKS FAILED`);
process.exit(1);
