/**
 * fix-nfa30w04-missing-variants.ts
 *
 * Product prod_01KK5CFJVG1BJVPQKR0H12EDVN (ESP-NFA30W04) has 3 color options
 * (3000K / 4000K / 6000K) but only the 3000K variant exists in product_variant.
 * The 0440 (4000K) and 0460 (6000K) inventory_items exist but were never
 * linked to real variants — an earlier orphan cleanup soft-deleted the bad
 * ghost links, leaving the items entirely unlinked.
 *
 * This script creates the 2 missing variants as siblings of 0430, links them
 * to their option values, copies the retail + wholesale prices from 0430,
 * and reconnects the existing inventory_items. Stock is zero so nothing is
 * lost by reusing the inventory_item rows.
 *
 * After the DB writes, it updates the 3 stale MeiliSearch `inventory`
 * documents in place so the POS edit modal picks up the real variantIds.
 *
 * Usage:
 *   cd backend
 *   npx ts-node src/scripts/fix/fix-nfa30w04-missing-variants.ts            # dry-run
 *   npx ts-node src/scripts/fix/fix-nfa30w04-missing-variants.ts --execute  # apply
 */

import "dotenv/config";
import postgres from "postgres";
import { ulid } from "ulid";

const DRY_RUN = !process.argv.includes("--execute");
const DATABASE_URL = process.env.DATABASE_URL!;
const MEILI_URL = process.env.MEILISEARCH_HOST!;
const MEILI_KEY = process.env.MEILISEARCH_API_KEY!;

if (!DATABASE_URL) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const PRODUCT_ID = "prod_01KK5CFJVG1BJVPQKR0H12EDVN";
const REF_VARIANT_ID = "variant_01KK5CFJVGS03ME7TM375799RW"; // 0430 / 3000K

interface Target {
  sku: string;
  title: string;
  option_value_id: string;
  variant_rank: number;
  inventory_item_id: string;
  meili_doc_id: string;
}

const TARGETS: Target[] = [
  {
    sku: "ESP-NFA30W0440",
    title: "4000K",
    option_value_id: "optval_01KK5CFJVJBKY6EZBE8GZJ73FJ",
    variant_rank: 1,
    inventory_item_id: "iitem_01KK5FCPHXWY9T4HR54EDDW19F",
    meili_doc_id: "iitem_01KK5FCPHXWY9T4HR54EDDW19F",
  },
  {
    sku: "ESP-NFA30W0460",
    title: "6000K",
    option_value_id: "optval_01KK5CFJVJXS664P1RHK9CWNS4",
    variant_rank: 2,
    inventory_item_id: "iitem_01KK5FCMGJHH7KY40VK04X058D",
    meili_doc_id: "iitem_01KK5FCMGJHH7KY40VK04X058D",
  },
];

function newId(prefix: string): string {
  return `${prefix}_${ulid()}`;
}

async function run() {
  console.log("━".repeat(60));
  console.log(
    `  Fix NFA30W04 Missing Variants  ${DRY_RUN ? "[DRY-RUN]" : "[EXECUTE]"}`
  );
  console.log("━".repeat(60) + "\n");

  const sql = postgres(DATABASE_URL, { max: 1 });

  // 1. Load reference price_set + prices from the existing 0430 variant.
  const refPs = await sql<{ price_set_id: string }[]>`
    SELECT pvps.price_set_id
    FROM product_variant_price_set pvps
    WHERE pvps.variant_id = ${REF_VARIANT_ID}
      AND pvps.deleted_at IS NULL
    LIMIT 1
  `;
  if (!refPs.length) {
    throw new Error(`Reference variant ${REF_VARIANT_ID} has no price_set`);
  }
  const refPriceSetId = refPs[0].price_set_id;

  const refPrices = await sql<
    {
      amount: string;
      currency_code: string;
      price_list_id: string | null;
      raw_amount: { value: string; precision: number };
      min_quantity: string | null;
      max_quantity: string | null;
    }[]
  >`
    SELECT amount, currency_code, price_list_id, raw_amount,
           min_quantity, max_quantity
    FROM price
    WHERE price_set_id = ${refPriceSetId}
      AND deleted_at IS NULL
  `;
  console.log(
    `Reference variant (0430) prices to copy (n=${refPrices.length}):`
  );
  for (const p of refPrices) {
    console.log(
      `  $${p.amount} ${p.currency_code}  price_list=${p.price_list_id ?? "NULL"}`
    );
  }
  console.log();

  const createdVariants: { sku: string; variant_id: string }[] = [];

  for (const t of TARGETS) {
    const existing = await sql<{ id: string }[]>`
      SELECT id FROM product_variant
      WHERE sku = ${t.sku} AND deleted_at IS NULL
    `;
    if (existing.length) {
      console.log(
        `⚠️   ${t.sku} already exists (${existing[0].id}) — skipping`
      );
      createdVariants.push({ sku: t.sku, variant_id: existing[0].id });
      continue;
    }

    const variantId = newId("variant");
    const priceSetId = newId("pset");
    const pvpsId = newId("pvps");
    const pviiId = newId("pvitem");

    console.log(`→ ${t.sku}  (${t.title})`);
    console.log(`    variant        = ${variantId}`);
    console.log(`    price_set      = ${priceSetId}`);
    console.log(`    inventory_item = ${t.inventory_item_id}  (reused)`);
    console.log(`    pvps link      = ${pvpsId}`);
    console.log(`    pvitem link    = ${pviiId}`);

    if (DRY_RUN) {
      console.log(`    [DRY-RUN] no writes\n`);
      createdVariants.push({ sku: t.sku, variant_id: variantId });
      continue;
    }

    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO product_variant
          (id, title, sku, allow_backorder, manage_inventory, variant_rank,
           product_id, created_at, updated_at)
        VALUES
          (${variantId}, ${t.title}, ${t.sku}, false, true, ${t.variant_rank},
           ${PRODUCT_ID}, now(), now())
      `;

      await tx`
        INSERT INTO product_variant_option (variant_id, option_value_id)
        VALUES (${variantId}, ${t.option_value_id})
      `;

      await tx`
        INSERT INTO price_set (id, created_at, updated_at)
        VALUES (${priceSetId}, now(), now())
      `;

      for (const p of refPrices) {
        await tx`
          INSERT INTO price
            (id, price_set_id, amount, raw_amount, currency_code,
             price_list_id, min_quantity, max_quantity, rules_count,
             created_at, updated_at)
          VALUES
            (${newId("price")}, ${priceSetId}, ${p.amount},
             ${p.raw_amount as unknown as object}, ${p.currency_code},
             ${p.price_list_id}, ${p.min_quantity}, ${p.max_quantity}, 0,
             now(), now())
        `;
      }

      await tx`
        INSERT INTO product_variant_price_set
          (variant_id, price_set_id, id, created_at, updated_at)
        VALUES
          (${variantId}, ${priceSetId}, ${pvpsId}, now(), now())
      `;

      await tx`
        INSERT INTO product_variant_inventory_item
          (variant_id, inventory_item_id, id, required_quantity,
           created_at, updated_at)
        VALUES
          (${variantId}, ${t.inventory_item_id}, ${pviiId}, 1, now(), now())
      `;
    });

    console.log(`    ✅  committed\n`);
    createdVariants.push({ sku: t.sku, variant_id: variantId });
  }

  await sql.end();

  // 2. Update MeiliSearch documents in place so the POS edit modal resolves
  //    the correct variant immediately. We only patch variantId — the rest
  //    of the document is untouched.
  if (!DRY_RUN && MEILI_URL && MEILI_KEY) {
    console.log("→ Patching MeiliSearch `inventory` documents...");
    const docs = createdVariants.map((v) => {
      const t = TARGETS.find((x) => x.sku === v.sku)!;
      return { id: t.meili_doc_id, variantId: v.variant_id };
    });
    const res = await fetch(
      `${MEILI_URL}/indexes/inventory/documents?primaryKey=id`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${MEILI_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(docs),
      }
    );
    if (!res.ok) {
      console.error(
        `   ⚠️  MeiliSearch patch failed: ${res.status} ${await res.text()}`
      );
    } else {
      const body = (await res.json()) as { taskUid?: number };
      console.log(`   ✅  MeiliSearch task enqueued: taskUid=${body.taskUid}`);
    }
  } else if (DRY_RUN) {
    console.log("→ [DRY-RUN] would patch MeiliSearch documents");
  }

  console.log("\n" + "━".repeat(60));
  console.log("Done.");
  console.log("━".repeat(60) + "\n");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
