/**
 * verify-product-meilisearch-subscriber.ts
 *
 * Static verification of the product-meilisearch sync subscriber. Reads the
 * source file and the `config.event` runtime export, then asserts each
 * required behavior is present in the code.
 *
 * Why static: the handler calls `import("meilisearch")` dynamically and runs
 * a Medusa workflow. Mocking either from outside the module is unreliable in
 * Node ESM, so we verify the source instead — faster and deterministic.
 *
 * Usage:
 *   cd backend
 *   npx tsx src/scripts/verify/verify-product-meilisearch-subscriber.ts
 */

import { readFileSync } from "fs";
import { resolve as resolvePath } from "path";

import { config } from "../../subscribers/product-thumbnail-sync";

const SUBSCRIBER_PATH = resolvePath(
  __dirname,
  "../../subscribers/product-thumbnail-sync.ts"
);

interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

function run() {
  const src = readFileSync(SUBSCRIBER_PATH, "utf8");
  const checks: Check[] = [];

  // 1. Config subscribes to all 3 lifecycle events.
  const events = Array.isArray(config.event) ? config.event : [config.event];
  const required = ["product.created", "product.updated", "product.deleted"];
  for (const ev of required) {
    checks.push({
      name: `config.event includes "${ev}"`,
      pass: events.includes(ev),
    });
  }

  // 2. Handler imports the sync workflow for upsert path.
  checks.push({
    name: "imports syncProductToMeiliSearchWorkflow",
    pass: /import\s+\{[^}]*syncProductToMeiliSearchWorkflow[^}]*\}\s+from\s+"\.\.\/workflows\/sync-product-meilisearch"/.test(
      src
    ),
  });

  // 3. Delete branch exists and short-circuits with deleteDocument on the
  //    products index + cascades inventory cleanup.
  const deleteBranch =
    /event\.name\s*===\s*"product\.deleted"[\s\S]*?deleteDocument\(\s*productId\s*\)/.test(
      src
    );
  checks.push({
    name: `delete branch calls client.index("products").deleteDocument(productId)`,
    pass: deleteBranch,
  });
  const deleteCascadesInventory =
    /event\.name\s*===\s*"product\.deleted"[\s\S]*?syncInventoryItemToMeiliSearchWorkflow[\s\S]*?deleteWhenMissing:\s*true/.test(
      src
    );
  checks.push({
    name: `delete branch also runs inventory cleanup via syncInventoryItemToMeiliSearchWorkflow(deleteWhenMissing:true)`,
    pass: deleteCascadesInventory,
  });

  // 4. Delete branch returns before falling through to upsert.
  const deleteReturnsEarly = /"product\.deleted"[\s\S]*?return;\s*\n\s*\}/.test(
    src
  );
  checks.push({
    name: "delete branch returns early (no accidental upsert)",
    pass: deleteReturnsEarly,
  });

  // 5. Upsert path calls the workflow with { productId }.
  const upsertCall =
    /syncProductToMeiliSearchWorkflow\s*\(\s*container\s*\)\s*\.\s*run\s*\(\s*\{[\s\S]*?productId[\s\S]*?\}\s*\)/.test(
      src
    );
  checks.push({
    name: "upsert path runs syncProductToMeiliSearchWorkflow with { productId }",
    pass: upsertCall,
  });

  // 6. Thumbnail auto-set is guarded to `product.updated` only.
  const thumbGuard =
    /event\.name\s*===\s*"product\.updated"[\s\S]*?!product\.thumbnail[\s\S]*?product\.images/.test(
      src
    );
  checks.push({
    name: "thumbnail auto-set is gated on event.name === 'product.updated'",
    pass: thumbGuard,
  });

  // 7. Failure isolation: Meili sync errors don't leak (wrapped in try/catch).
  const hasInnerTryCatch = /try\s*\{[\s\S]*?syncProductToMeiliSearchWorkflow[\s\S]*?\}\s*catch\s*\(/m.test(
    src
  );
  checks.push({
    name: "upsert call is wrapped in try/catch so Meili failures don't propagate",
    pass: hasInnerTryCatch,
  });

  // 8. Empty productId short-circuits.
  const emptyIdGuard = /if\s*\(\s*!productId\s*\)\s*return/.test(src);
  checks.push({
    name: "handler returns early on missing productId",
    pass: emptyIdGuard,
  });

  // Render report.
  console.log("━".repeat(60));
  console.log("  F1.1 Product Meilisearch Subscriber — static verification");
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
    console.log("✅ ALL CHECKS PASSED");
    process.exit(0);
  }
  console.log(`❌ ${failed} CHECK(S) FAILED`);
  process.exit(1);
}

run();
