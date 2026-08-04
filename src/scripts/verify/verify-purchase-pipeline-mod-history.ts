/**
 * verify-purchase-pipeline-mod-history.ts
 *
 * Audits the Purchase Pipeline feed's core promise: every QuickBooks MOD is a
 * record of its own, dated when it happened, and no operation is shown twice.
 *
 * Run:
 *   env DATABASE_URL="$(grep ^DATABASE_URL= .env | cut -d= -f2-)" \
 *     ./node_modules/.bin/tsx src/scripts/verify/verify-purchase-pipeline-mod-history.ts
 *
 * Read-only: every statement is a SELECT.
 *
 * It imports the SAME constant the route serves (`_lib/feed-sql.ts`). Comparing
 * a re-typed copy against the tables would prove nothing about what the
 * operator sees — the copy is exactly what drifts.
 *
 * Each check crosses the feed against the SOURCE TABLES, never against the feed
 * itself. Mutation-tested before being trusted: reverting either half of the
 * change (the mod lanes, or the legacy suppression) turns checks 1/2/5/6 red.
 */

import { Client } from "pg";

import { PURCHASE_PIPELINE_FEED_SQL } from "../../api/admin/purchase-orders/qb-pipeline/_lib/feed-sql";

const FEED = `SELECT * FROM (${PURCHASE_PIPELINE_FEED_SQL}) feed`;

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail: string): void {
  if (ok) {
    passed += 1;
    console.log(`  ✅ ${name} — ${detail}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name} — ${detail}`);
  }
}

async function main(): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const q = async <T = Record<string, string>>(
    sql: string,
    values: unknown[] = []
  ): Promise<T[]> => (await client.query(sql, values)).rows as T[];

  try {
    console.log("\n🏭 Purchase Pipeline — MOD history audit\n");

    // ── 1/2 · Every chained MOD reaches the feed exactly once ──────────────
    for (const [step, lane] of [
      ["purchase_order_mod", "mod_purchase_order"],
      ["item_receipt_mod", "mod_item_receipt"],
    ] as const) {
      const [source] = await q<{ count: string }>(
        `SELECT COUNT(*) AS count FROM qb_order_pipeline WHERE step = $1`,
        [step]
      );
      const [feed] = await q<{ count: string }>(
        `SELECT COUNT(*) AS count FROM (${FEED}) f
          WHERE f.step = $1 AND f.id LIKE '%__' || $2`,
        [lane, step]
      );
      check(
        `every ${step} row is its own feed record`,
        source.count === feed.count,
        `${source.count} in qb_order_pipeline, ${feed.count} in the feed`
      );
    }

    // ── 3 · No operation is rendered twice ─────────────────────────────────
    const dupes = await q<{ id: string; n: string }>(
      `SELECT id, COUNT(*) AS n FROM (${FEED}) f GROUP BY id HAVING COUNT(*) > 1`
    );
    check(
      "no duplicated feed id",
      dupes.length === 0,
      dupes.length === 0
        ? "every row appears once"
        : `${dupes.length} duplicated: ${dupes
            .slice(0, 3)
            .map((d) => `${d.id}×${d.n}`)
            .join(", ")}`
    );

    // ── 4 · Conservation: the feed is exactly its sources, nothing invented
    const [{ total: feedTotal }] = await q<{ total: string }>(
      `SELECT COUNT(*) AS total FROM (${FEED}) f`
    );
    const [expected] = await q<{ total: string }>(`
      SELECT (
        (SELECT COUNT(*) FROM qb_purchase_order_pipeline WHERE deleted_at IS NULL)
      + (SELECT COUNT(*) FROM qb_item_receipt_pipeline WHERE deleted_at IS NULL)
      + (SELECT COUNT(*) FROM qb_item_receipt_pipeline
          WHERE deleted_at IS NULL AND mod_status IS NOT NULL
            AND mod_order_pipeline_id IS NULL)
      + (SELECT COUNT(*) FROM qb_item_receipt_pipeline
          WHERE deleted_at IS NULL AND void_status IS NOT NULL)
      + (SELECT COUNT(*) FROM qb_vendor_bill_pipeline qvb
          JOIN vendor_bill vb ON vb.id = qvb.vendor_bill_id AND vb.deleted_at IS NULL
         WHERE qvb.deleted_at IS NULL
           AND (qvb.intent = 'add' OR qvb.qb_txn_id IS NOT NULL))
      + (SELECT COUNT(*) FROM qb_vendor_bill_pipeline qvb
          JOIN vendor_bill vb ON vb.id = qvb.vendor_bill_id AND vb.deleted_at IS NULL
         WHERE qvb.deleted_at IS NULL AND qvb.void_status IS NOT NULL)
      + (SELECT COUNT(*) FROM qb_order_pipeline qop
          JOIN vendor_bill vb ON vb.id = qop.reference_id AND vb.deleted_at IS NULL
         WHERE qop.step IN ('vendor_bill_mod', 'vendor_bill_rebuild_preflight',
                            'vendor_bill_rebuild_delete'))
      + (SELECT COUNT(*) FROM qb_order_pipeline
          WHERE step IN ('purchase_order_mod', 'item_receipt_mod'))
      ) AS total
    `);
    check(
      "feed row count equals the sum of its sources",
      feedTotal === expected.total,
      `feed ${feedTotal}, sources ${expected.total}`
    );

    // ── 5 · A delegated legacy PO row no longer masquerades as the mod ─────
    const masquerading = await q<{ po: string; step: string; status: string }>(`
      SELECT COALESCE(po.number, pipe.purchase_order_id) AS po,
             f.step AS step, f.status AS status
        FROM qb_purchase_order_pipeline pipe
        LEFT JOIN purchase_order po ON po.id = pipe.purchase_order_id
        JOIN (${FEED}) f ON f.id = pipe.id
       WHERE pipe.deleted_at IS NULL
         AND pipe.order_pipeline_id IS NOT NULL
         AND pipe.qb_list_id IS NOT NULL
         AND (pipe.payload->>'is_void')::boolean IS NOT TRUE
         AND (f.step <> 'purchase_order' OR f.status <> 'synced')
    `);
    check(
      "delegated legacy PO rows render as the ADD, not as the mod",
      masquerading.length === 0,
      masquerading.length === 0
        ? "no legacy row is wearing a mod's status"
        : `${masquerading.length} still are, e.g. ${masquerading[0].po} → ${masquerading[0].step}/${masquerading[0].status}`
    );

    // ── 6 · A mod is dated when IT happened, not when the PO was created ───
    const misdated = await q<{ id: string; feed_at: string; real_at: string }>(`
      SELECT qop.id AS id, f.created_at AS feed_at, qop.created_at AS real_at
        FROM qb_order_pipeline qop
        JOIN (${FEED}) f ON f.id = qop.id::text || '__' || qop.step
       WHERE qop.step IN ('purchase_order_mod', 'item_receipt_mod')
         AND f.created_at IS DISTINCT FROM qop.created_at
    `);
    check(
      "each mod carries its own timestamp",
      misdated.length === 0,
      misdated.length === 0
        ? "feed created_at matches the operation's own"
        : `${misdated.length} misdated, e.g. ${misdated[0].id}`
    );

    // ── 7 · The multi-mod case the whole change exists for ────────────────
    const [busiest] = await q<{ order_id: string; n: string }>(`
      SELECT order_id, COUNT(*) AS n
        FROM qb_order_pipeline
       WHERE step = 'purchase_order_mod'
       GROUP BY order_id
       ORDER BY COUNT(*) DESC, order_id
       LIMIT 1
    `);
    if (!busiest) {
      check(
        "a PO with several mods shows one row per mod",
        true,
        "no chained PO mods recorded yet — nothing to compare"
      );
    } else {
      const [{ count: shown }] = await q<{ count: string }>(
        `SELECT COUNT(*) AS count FROM (${FEED}) f
          WHERE f.step = 'mod_purchase_order'
            AND f.parent_id = $1
            AND f.id LIKE '%__purchase_order_mod'`,
        [busiest.order_id]
      );
      check(
        "a PO with several mods shows one row per mod",
        shown === busiest.n,
        `PO ${busiest.order_id}: ${busiest.n} mods recorded, ${shown} rows shown`
      );
    }

    console.log(
      `\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed\n`
    );
  } finally {
    await client.end();
  }
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("verify-purchase-pipeline-mod-history failed:", err);
  process.exit(1);
});
