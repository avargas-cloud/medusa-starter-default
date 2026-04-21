/**
 * verify-product-variant-subscriber.ts
 *
 * Static verification for F1.3 — product-variant lifecycle subscriber.
 * Asserts the subscriber listens to the 3 real Medusa core event names
 * and delegates to the incremental inventory workflow correctly.
 *
 * Usage:
 *   cd backend
 *   npx tsx src/scripts/verify/verify-product-variant-subscriber.ts
 */

import { readFileSync } from "fs";
import { resolve as resolvePath } from "path";

import { config } from "../../subscribers/product-variant-meilisearch-sync";

const SRC_PATH = resolvePath(
  __dirname,
  "../../subscribers/product-variant-meilisearch-sync.ts"
);

interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}
const checks: Check[] = [];
function add(name: string, pass: boolean, detail?: string) {
  checks.push({ name, pass, detail });
}

const src = readFileSync(SRC_PATH, "utf8");

// 1. Correct event names — these come from ProductVariantWorkflowEvents in
//    @medusajs/utils (verified by reading core-flows/events.js).
const events = Array.isArray(config.event) ? config.event : [config.event];
const required = [
  "product-variant.created",
  "product-variant.updated",
  "product-variant.deleted",
];
for (const ev of required) {
  add(`config.event includes "${ev}"`, events.includes(ev));
}

// 2. Imports the incremental workflow.
add(
  "imports syncInventoryItemToMeiliSearchWorkflow",
  /import\s+\{[^}]*syncInventoryItemToMeiliSearchWorkflow[^}]*\}\s+from\s+"\.\.\/workflows\/sync-inventory-item-meilisearch"/.test(
    src
  )
);

// 3. Handles array id payloads (variant workflows emit id OR id[]).
add(
  "handles both scalar and array id payloads",
  /Array\.isArray\(\s*rawId\s*\)/.test(src)
);

// 4. Delete path uses deleteWhenMissing=true.
add(
  "delete path passes deleteWhenMissing: true to the workflow",
  /"product-variant\.deleted"[\s\S]*?deleteWhenMissing[\s\S]*?true/.test(src) ||
    /isDelete[\s\S]*?deleteWhenMissing:\s*isDelete/.test(src)
);

// 5. Scopes by variantId (narrower than productId for surgical sync).
add(
  "scopes workflow by variantId",
  /syncInventoryItemToMeiliSearchWorkflow[\s\S]*?variantId/.test(src)
);

// 6. No-ops on missing payload id.
add(
  "returns early when rawId is missing",
  /if\s*\(\s*!rawId\s*\)\s*return/.test(src)
);

// 7. Wraps each variant run in try/catch so one failure doesn't abort others.
add(
  "iterates variant ids with per-id try/catch",
  /for\s*\(\s*const\s+variantId\s+of\s+variantIds\s*\)[\s\S]*?try\s*\{[\s\S]*?catch\s*\(/.test(
    src
  )
);

console.log("━".repeat(60));
console.log("  F1.3 Product-Variant Meilisearch Subscriber — verification");
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
