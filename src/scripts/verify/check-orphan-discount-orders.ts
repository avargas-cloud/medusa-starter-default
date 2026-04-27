/**
 * scripts/verify/check-orphan-discount-orders.ts
 *
 * Lists orders that have `metadata.promotion_code` set (so the POS thinks
 * a discount is applied) but ZERO `order_line_item_adjustment` rows. These
 * are the "orphaned discount" state where Medusa's `total` is inflated by
 * the missing discount even though the UI shows the correct computed_total.
 *
 * Read-only — does not modify anything. Run before/after deploys to make
 * sure the apply-discount-force fix is holding.
 *
 * Run: yarn ts-node src/scripts/verify/check-orphan-discount-orders.ts
 */

import { Client } from "pg";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.join(__dirname, "../../../.env") });

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{
      order_id: string;
      display_id: number;
      promotion_code: string;
      computed_total: string | null;
      adj_count: string;
      promo_links: string;
      pending_changes: string;
      stale_version_adj: string;
      is_draft_order: boolean;
      created_at: string;
    }>(`
      SELECT o.id AS order_id,
             o.display_id,
             o.metadata->>'promotion_code' AS promotion_code,
             o.metadata->>'computed_total' AS computed_total,
             (SELECT count(*)
                FROM order_line_item_adjustment olia
                JOIN order_item oi ON oi.item_id = olia.item_id
                WHERE oi.order_id = o.id AND olia.deleted_at IS NULL) AS adj_count,
             (SELECT count(*) FROM order_promotion op WHERE op.order_id = o.id AND op.deleted_at IS NULL) AS promo_links,
             (SELECT count(*) FROM order_change oc WHERE oc.order_id = o.id AND oc.status = 'pending' AND oc.deleted_at IS NULL) AS pending_changes,
             (SELECT count(*) FROM order_line_item_adjustment olia
                JOIN order_item oi ON oi.item_id = olia.item_id
                WHERE oi.order_id = o.id AND olia.deleted_at IS NULL
                  AND olia.version != (SELECT MAX(version) FROM order_item WHERE order_id = o.id)) AS stale_version_adj,
             o.is_draft_order,
             o.created_at::text
      FROM "order" o
      WHERE o.metadata->>'promotion_code' IS NOT NULL
        AND o.deleted_at IS NULL
      ORDER BY o.created_at DESC
    `);

    const orphans = rows.filter(
      (r) => Number(r.adj_count) === 0 || Number(r.promo_links) === 0
    );
    const zombies = rows.filter((r) => Number(r.pending_changes) > 0);
    const staleVersions = rows.filter((r) => Number(r.stale_version_adj) > 0);

    const tag = (r: typeof rows[number]) =>
      r.is_draft_order ? "E" : "S";

    console.log(
      `Scanned ${rows.length} orders/estimates with promotion_code metadata.`
    );
    console.log(
      `\n🔴 ORPHANED-DISCOUNT (0 adjustments OR 0 promo links): ${orphans.length}`
    );
    for (const r of orphans) {
      console.log(
        `  ${tag(r)}${r.display_id}  ${r.order_id}  promo=${r.promotion_code}  adj=${r.adj_count}  link=${r.promo_links}  pendingChanges=${r.pending_changes}  computed=${r.computed_total}`
      );
    }
    console.log(
      `\n🟠 STALE-VERSION ADJUSTMENTS (Medusa won't see them): ${staleVersions.length}`
    );
    for (const r of staleVersions) {
      console.log(
        `  ${tag(r)}${r.display_id}  ${r.order_id}  staleAdj=${r.stale_version_adj}/${r.adj_count}`
      );
    }
    console.log(
      `\n🟡 ZOMBIE order_change pending (may block edits): ${zombies.length}`
    );
    for (const r of zombies) {
      console.log(
        `  ${tag(r)}${r.display_id}  ${r.order_id}  pending=${r.pending_changes}`
      );
    }

    process.exitCode =
      orphans.length > 0 || staleVersions.length > 0 ? 1 : 0;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
