/**
 * fix-customer-groups-from-qb.ts
 *
 * Checks all customers with QB metadata (qb_price_level) and ensures they are
 * assigned to the correct Medusa customer group (Wholesale or Retail).
 *
 * Usage:
 *   npx tsx src/scripts/fix/fix-customer-groups-from-qb.ts          # dry run
 *   npx tsx src/scripts/fix/fix-customer-groups-from-qb.ts --apply  # apply changes
 */

import * as dotenv from "dotenv";
dotenv.config();

import { Client } from "pg";
import { randomBytes } from "crypto";

// Generate a Medusa-compatible ID with prefix (mimics generateEntityId)
function genId(prefix: string): string {
  // Crockford base32 alphabet
  const CHARS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const ts = Date.now();
  let t = ts;
  let tStr = "";
  for (let i = 0; i < 10; i++) {
    tStr = CHARS[t % 32] + tStr;
    t = Math.floor(t / 32);
  }
  const randBytes = randomBytes(10);
  let rStr = "";
  for (const byte of randBytes) {
    rStr += CHARS[byte % 32];
  }
  return `${prefix}_${tStr}${rStr}`;
}

const DRY_RUN = !process.argv.includes("--apply");
const SYNC_MEILI = process.argv.includes("--sync-meili");

// ─────────────────────────────────────────────────────────────
// Price level mapping — matches logic in sync-customers-core.ts
// ─────────────────────────────────────────────────────────────
function resolveTargetGroup(
  qbPriceLevel: string | null | undefined
): "Wholesale" | "Retail" {
  const level = (qbPriceLevel || "").toLowerCase();
  if (level.includes("wholesale") || level.includes("distributor")) {
    return "Wholesale";
  }
  return "Retail";
}

async function main() {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  QB Customer Group Fix Script`);
  console.log(
    `  Mode: ${DRY_RUN ? "🔍 DRY RUN (no changes)" : "✏️  APPLY CHANGES"}`
  );
  console.log(`${"=".repeat(60)}\n`);

  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  try {
    // 1. Load customer groups
    const groupRows = await db.query<{ id: string; name: string }>(
      `SELECT id, name FROM customer_group WHERE deleted_at IS NULL`
    );

    const groupMap: Record<string, string> = {};
    for (const row of groupRows.rows) {
      groupMap[row.name] = row.id;
    }

    const wholesaleGroupId = groupMap["Wholesale"];
    const retailGroupId = groupMap["Retail"];

    if (!wholesaleGroupId || !retailGroupId) {
      console.error(
        "❌ Could not find Wholesale or Retail customer group in Medusa."
      );
      console.error(
        "   Available groups:",
        groupRows.rows.map((r) => r.name).join(", ")
      );
      process.exit(1);
    }

    console.log(`✅ Groups loaded:`);
    console.log(`   Wholesale  → ${wholesaleGroupId}`);
    console.log(`   Retail     → ${retailGroupId}\n`);

    // 2. Load all customers with QB metadata
    const customerRows = await db.query<{
      id: string;
      email: string;
      metadata: any;
    }>(`
            SELECT id, email, metadata
            FROM customer
            WHERE deleted_at IS NULL
              AND metadata IS NOT NULL
              AND (metadata->>'qb_list_id' IS NOT NULL OR metadata->>'legacy_customer' = 'true')
        `);

    console.log(`📊 Found ${customerRows.rows.length} QB customers to check\n`);

    // 3. Load existing group memberships
    const membershipRows = await db.query<{
      customer_id: string;
      customer_group_id: string;
    }>(
      `
            SELECT customer_id, customer_group_id
            FROM customer_group_customer
            WHERE customer_id = ANY($1)
        `,
      [customerRows.rows.map((r) => r.id)]
    );

    // Build map: customerId → Set<groupId>
    const currentGroups = new Map<string, Set<string>>();
    for (const row of membershipRows.rows) {
      if (!currentGroups.has(row.customer_id)) {
        currentGroups.set(row.customer_id, new Set());
      }
      currentGroups.get(row.customer_id)!.add(row.customer_group_id);
    }

    // 4. Determine actions needed
    const toAddWholesale: string[] = [];
    const toAddRetail: string[] = [];
    const alreadyCorrect: string[] = [];
    const noChange: string[] = [];

    for (const customer of customerRows.rows) {
      const meta = customer.metadata || {};
      const qbPriceLevel = meta.qb_price_level || meta.price_level || "";
      const targetGroup = resolveTargetGroup(qbPriceLevel);
      const targetGroupId =
        targetGroup === "Wholesale" ? wholesaleGroupId : retailGroupId;

      const groups = currentGroups.get(customer.id) || new Set();
      const isInTargetGroup = groups.has(targetGroupId);
      const isInOtherGroup =
        targetGroup === "Wholesale"
          ? groups.has(retailGroupId)
          : groups.has(wholesaleGroupId);

      if (isInTargetGroup && !isInOtherGroup) {
        alreadyCorrect.push(customer.email);
      } else if (!isInTargetGroup) {
        if (targetGroup === "Wholesale") {
          toAddWholesale.push(customer.id);
        } else {
          toAddRetail.push(customer.id);
        }
        if (isInOtherGroup) {
          console.log(
            `   🔄 ${customer.email} — moving from ${targetGroup === "Wholesale" ? "Retail" : "Wholesale"} → ${targetGroup}`
          );
        } else {
          console.log(`   ➕ ${customer.email} — assign to ${targetGroup}`);
        }
      } else {
        noChange.push(customer.email);
      }
    }

    console.log(`\n${"─".repeat(60)}`);
    console.log(`  SUMMARY`);
    console.log(`${"─".repeat(60)}`);
    console.log(`  Already in correct group:  ${alreadyCorrect.length}`);
    console.log(`  Need Wholesale group:      ${toAddWholesale.length}`);
    console.log(`  Need Retail group:         ${toAddRetail.length}`);
    console.log(`  In both groups (skip):     ${noChange.length}`);
    console.log(`${"─".repeat(60)}\n`);

    if (DRY_RUN) {
      console.log(`🔍 DRY RUN complete — no changes made.`);
      console.log(`   Run with --apply to apply these changes.\n`);
      return;
    }

    // 5. Apply changes
    let applied = 0;

    if (toAddWholesale.length > 0) {
      // Remove from Retail first
      await db.query(
        `
                DELETE FROM customer_group_customer
                WHERE customer_id = ANY($1) AND customer_group_id = $2
            `,
        [toAddWholesale, retailGroupId]
      );

      // Add to Wholesale — one INSERT per customer with generated id
      for (const customerId of toAddWholesale) {
        const id = genId("cusgc");
        await db.query(
          `
                    INSERT INTO customer_group_customer (id, customer_id, customer_group_id)
                    VALUES ($1, $2, $3)
                    ON CONFLICT DO NOTHING
                `,
          [id, customerId, wholesaleGroupId]
        );
      }
      applied += toAddWholesale.length;
      console.log(
        `✅ Assigned ${toAddWholesale.length} customers to Wholesale`
      );
    }

    if (toAddRetail.length > 0) {
      // Remove from Wholesale first
      await db.query(
        `
                DELETE FROM customer_group_customer
                WHERE customer_id = ANY($1) AND customer_group_id = $2
            `,
        [toAddRetail, wholesaleGroupId]
      );

      // Add to Retail — one INSERT per customer with generated id
      for (const customerId of toAddRetail) {
        const id = genId("cusgc");
        await db.query(
          `
                    INSERT INTO customer_group_customer (id, customer_id, customer_group_id)
                    VALUES ($1, $2, $3)
                    ON CONFLICT DO NOTHING
                `,
          [id, customerId, retailGroupId]
        );
      }
      applied += toAddRetail.length;
      console.log(`✅ Assigned ${toAddRetail.length} customers to Retail`);
    }

    console.log(`\n✅ Done! ${applied} customers updated.`);

    // 6. Optionally sync MeiliSearch (pass --sync-meili to enable)
    const allAffected = [...toAddWholesale, ...toAddRetail];
    if (SYNC_MEILI && allAffected.length > 0) {
      console.log(
        `\n🔄 Syncing ${allAffected.length} customers to MeiliSearch...`
      );

      const { MeiliSearch } = await import("meilisearch");
      const meili = new MeiliSearch({
        host: process.env.MEILISEARCH_HOST!,
        apiKey: process.env.MEILISEARCH_API_KEY!,
      });
      const index = meili.index("customers");

      const affectedRows = await db.query<{
        id: string;
        email: string;
        first_name: string;
        last_name: string;
        company_name: string;
        phone: string;
        has_account: boolean;
        metadata: any;
        created_at: Date;
        updated_at: Date;
      }>(
        `
                SELECT id, email, first_name, last_name, company_name, phone,
                       has_account, metadata, created_at, updated_at
                FROM customer WHERE id = ANY($1)
            `,
        [allAffected]
      );

      const newGroupRows = await db.query<{
        customer_id: string;
        name: string;
      }>(
        `
                SELECT cgc.customer_id, cg.name
                FROM customer_group_customer cgc
                JOIN customer_group cg ON cgc.customer_group_id = cg.id
                WHERE cgc.customer_id = ANY($1)
            `,
        [allAffected]
      );

      const groupsByCustomer = new Map<string, string[]>();
      for (const row of newGroupRows.rows) {
        if (!groupsByCustomer.has(row.customer_id))
          groupsByCustomer.set(row.customer_id, []);
        groupsByCustomer.get(row.customer_id)!.push(row.name);
      }

      const docs = affectedRows.rows.map((c) => {
        const meta = c.metadata || {};
        const groups = groupsByCustomer.get(c.id) || [];
        const price_level = groups.includes("Wholesale")
          ? "Wholesale"
          : "Retail";
        return {
          id: c.id,
          email: c.email,
          first_name: c.first_name || "",
          last_name: c.last_name || "",
          company_name: c.company_name || "",
          phone: c.phone || "",
          has_account: c.has_account,
          status: c.has_account ? "Registered" : "Guest",
          list_id: meta.qb_list_id || "",
          customer_type:
            meta.qb_customer_type || meta.customer_type || "Standard",
          price_level,
          groups,
          updated_at: new Date(c.updated_at).getTime(),
          created_at: new Date(c.created_at).getTime(),
        };
      });

      await index.updateDocuments(docs);
      console.log(`✅ MeiliSearch synced for ${docs.length} customers\n`);
    } else if (!SYNC_MEILI && allAffected.length > 0) {
      console.log(
        `ℹ️  MeiliSearch sync skipped. Run with --sync-meili to sync.\n`
      );
    }
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error("❌ Script failed:", err.message);
  process.exit(1);
});
