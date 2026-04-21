/**
 * verify-qb-scripts-meili-coverage.ts
 *
 * F4 audit. Scans every script in src/scripts/qb_sync/core_jobs/ that
 * mutates Medusa data and classifies how its MeiliSearch coverage is
 * provided. After F1 (product + variant + customer lifecycle subscribers)
 * most scripts are auto-synced for free because they call Medusa module
 * services / workflows that emit lifecycle events.
 *
 * A script is considered "covered" if it uses any of:
 *   • productModule / customerModule (event-emitting module services)
 *   • updateProductsWorkflow / createProductsWorkflow / createProductVariantsWorkflow
 *   • syncInventoryWorkflow / syncProductToMeiliSearchWorkflow (explicit)
 *
 * Scripts that mutate data via raw SQL (the `postgres` npm package) and
 * DO NOT call any of the above are flagged as POTENTIAL GAPS — raw SQL
 * bypasses Medusa events entirely so the subscriber cascade won't fire.
 *
 * Usage:
 *   cd backend
 *   npx tsx src/scripts/verify/verify-qb-scripts-meili-coverage.ts
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join, resolve as resolvePath } from "path";

const QB_DIR = resolvePath(__dirname, "../../scripts/qb_sync/core_jobs");

function readAll(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isFile() && p.endsWith(".ts")) out.push(p);
  }
  return out;
}

interface Audit {
  file: string;
  mutates: boolean;
  eventEmitter: boolean;
  explicitMeili: boolean;
  rawSqlOnly: boolean;
  readOnly: boolean;
}

function audit(path: string): Audit {
  const src = readFileSync(path, "utf8");

  const usesModuleService =
    /\bproductModule[A-Za-z_]*\s*\./.test(src) ||
    /\bcustomerModule[A-Za-z_]*\s*\./.test(src) ||
    /Modules\.PRODUCT\b/.test(src) ||
    /Modules\.CUSTOMER\b/.test(src) ||
    /\.updateProducts\(/.test(src) ||
    /\.createProducts\(/.test(src) ||
    /\.deleteProducts\(/.test(src) ||
    /\.updateProductVariants\(/.test(src) ||
    /\.createProductVariants\(/.test(src) ||
    /\.deleteProductVariants\(/.test(src) ||
    /\.updateCustomers\(/.test(src) ||
    /\.createCustomers\(/.test(src);

  const usesEventEmittingWorkflow =
    /updateProductsWorkflow|createProductsWorkflow|createProductVariantsWorkflow|updateProductVariantsWorkflow|deleteProductVariantsWorkflow|deleteProductsWorkflow/.test(
      src
    );

  const explicitMeili =
    /syncInventoryWorkflow|syncProductToMeiliSearchWorkflow|syncInventoryItemToMeiliSearchWorkflow|new\s+MeiliSearch\(/.test(
      src
    );

  // Scripts that call sync-inventory-core / sync-prices-core transitively
  // invoke syncInventoryWorkflow at the end — they are covered even though
  // the Meili workflow doesn't appear in their own source.
  const transitiveMeili =
    /from\s+".*sync-inventory-core"/.test(src) ||
    /from\s+".*sync-prices-core"/.test(src);

  const rawSqlOnly =
    /from\s+"postgres"/.test(src) ||
    /from\s+"pg"/.test(src) ||
    /require\s*\(\s*"postgres"\s*\)/.test(src) ||
    /require\s*\(\s*"pg"\s*\)/.test(src);

  const mutatesHeuristic =
    /INSERT INTO|UPDATE\s+\w|DELETE FROM|\.updateProducts\b|\.createProducts\b|\.updateProductVariants\b|\.createProductVariants\b|\.addDocuments\(|\.updateDocuments\(/.test(
      src
    );

  const readOnly = !mutatesHeuristic;

  return {
    file: path.split("/").slice(-1)[0]!,
    mutates: mutatesHeuristic,
    eventEmitter: usesModuleService || usesEventEmittingWorkflow,
    explicitMeili: explicitMeili || transitiveMeili,
    rawSqlOnly,
    readOnly,
  };
}

function run() {
  const files = readAll(QB_DIR);
  const audits = files.map(audit);

  const categorized = {
    readOnly: audits.filter((a) => a.readOnly),
    autoCovered: audits.filter(
      (a) => a.mutates && (a.eventEmitter || a.explicitMeili)
    ),
    potentialGap: audits.filter(
      (a) => a.mutates && !a.eventEmitter && !a.explicitMeili
    ),
  };

  console.log("━".repeat(60));
  console.log("  F4 QB Scripts — MeiliSearch coverage audit");
  console.log("━".repeat(60));
  console.log(`Scanned ${audits.length} scripts in qb_sync/core_jobs/\n`);

  console.log(`✅  Auto-covered (${categorized.autoCovered.length})`);
  console.log(
    "    — these mutate data via Medusa module services or workflows,"
  );
  console.log(
    "    — so the F1 lifecycle subscribers propagate to MeiliSearch for free."
  );
  for (const a of categorized.autoCovered) {
    const tags: string[] = [];
    if (a.eventEmitter) tags.push("module-service");
    if (a.explicitMeili) tags.push("explicit-sync");
    console.log(`      • ${a.file}   (${tags.join(", ")})`);
  }

  console.log(
    `\nℹ️   Read-only / no data mutation (${categorized.readOnly.length})`
  );
  for (const a of categorized.readOnly) {
    console.log(`      • ${a.file}`);
  }

  console.log(
    `\n${categorized.potentialGap.length === 0 ? "✅" : "⚠️ "}  Potential coverage gaps (${categorized.potentialGap.length})`
  );
  console.log(
    "    — these mutate data but don't obviously use event-emitting paths"
  );
  console.log("    — and have no explicit MeiliSearch sync call.");
  for (const a of categorized.potentialGap) {
    console.log(
      `      • ${a.file}   (rawSql=${a.rawSqlOnly ? "yes" : "no"})`
    );
  }

  console.log("\n" + "━".repeat(60));
  if (categorized.potentialGap.length === 0) {
    console.log(
      "✅ Every mutating script is covered. The F1 subscriber cascade"
    );
    console.log("   keeps Meili fresh without any explicit calls.");
    process.exit(0);
  }
  console.log(
    `⚠️   ${categorized.potentialGap.length} script(s) may leave Meili stale. Review listed files`
  );
  console.log(
    "    and either route their writes through the Medusa module services"
  );
  console.log(
    "    or add an explicit syncInventoryItemToMeiliSearchWorkflow call."
  );
  process.exit(1);
}

run();
