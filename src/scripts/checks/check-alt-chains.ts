/**
 * check-alt-chains.ts
 *
 * Finds variants that are BOTH an alternative of another product AND registered
 * as a primary with their own alternatives — creating ambiguous "chains"
 * (A → B → C) that cause revenue to be lost in Pareto analysis.
 *
 * Also finds self-referential entries (a variant listed as its own alt).
 *
 * Usage (dry-run):
 *   npx ts-node -r tsconfig-paths/register src/scripts/checks/check-alt-chains.ts
 *
 * Fix (deactivate chain entries — B's own alt-registrations are removed):
 *   APPLY=true npx ts-node -r tsconfig-paths/register src/scripts/checks/check-alt-chains.ts
 *
 * Fix + promote (move B's alts → A before deactivating, so C stays visible):
 *   APPLY=true PROMOTE=true npx ts-node -r tsconfig-paths/register src/scripts/checks/check-alt-chains.ts
 */

import * as dotenv from "dotenv";
import { Client } from "pg";

dotenv.config();

const APPLY = process.env.APPLY === "true";
const PROMOTE = process.env.PROMOTE === "true";

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  console.log("=== Alternative Chain Audit ===\n");
  if (APPLY) {
    console.log(PROMOTE ? "MODE: APPLY + PROMOTE (chain alts → grandparent primary)\n" : "MODE: APPLY (deactivate chain entries only)\n");
  } else {
    console.log("MODE: DRY-RUN (pass APPLY=true to fix)\n");
  }

  // ── 1. Self-referential entries ─────────────────────────────────────────────
  const { rows: selfRefs } = await db.query<{
    id: string;
    variant_id: string;
    sku: string;
  }>(`
    SELECT pa.id, pv.id AS variant_id, COALESCE(pv.sku, pa.primary_variant_id) AS sku
    FROM product_alternative pa
    JOIN product_variant pv ON pv.id = pa.primary_variant_id AND pv.deleted_at IS NULL
    WHERE pa.primary_variant_id = pa.alt_variant_id
      AND pa.is_active = true
      AND pa.deleted_at IS NULL
    ORDER BY sku
  `);

  console.log(`── Self-referential entries (primary = alt): ${selfRefs.length}`);
  for (const r of selfRefs) {
    console.log(`  [link: ${r.id}] ${r.sku} → itself`);
  }

  if (APPLY && selfRefs.length > 0) {
    const ids = selfRefs.map((r) => r.id);
    await db.query(
      `UPDATE product_alternative SET is_active = false, updated_at = now()
       WHERE id = ANY($1::text[])`,
      [ids]
    );
    console.log(`  → Deactivated ${selfRefs.length} self-referential entries.\n`);
  } else if (selfRefs.length > 0) {
    console.log(`  → Would deactivate ${selfRefs.length} self-referential entries.\n`);
  } else {
    console.log("  → None found.\n");
  }

  // ── 2. Chain entries (B is alt of A, AND B is primary of C) ─────────────────
  const { rows: chains } = await db.query<{
    chain_link_id: string;   // pa.id where primary=B, alt=C
    b_variant_id: string;
    b_sku: string;
    c_variant_id: string;
    c_sku: string;
    a_variant_id: string;    // who "owns" B as an alt
    a_sku: string;
    a_link_id: string;       // pa.id where primary=A, alt=B
  }>(`
    SELECT
      pa_bc.id        AS chain_link_id,
      pv_b.id         AS b_variant_id,
      pv_b.sku        AS b_sku,
      pv_c.id         AS c_variant_id,
      pv_c.sku        AS c_sku,
      pv_a.id         AS a_variant_id,
      pv_a.sku        AS a_sku,
      pa_ab.id        AS a_link_id
    FROM product_alternative pa_bc
    -- B is primary of C
    JOIN product_variant pv_b ON pv_b.id = pa_bc.primary_variant_id AND pv_b.deleted_at IS NULL
    JOIN product_variant pv_c ON pv_c.id = pa_bc.alt_variant_id     AND pv_c.deleted_at IS NULL
    -- B is also an alt of A
    JOIN product_alternative pa_ab
      ON pa_ab.alt_variant_id = pa_bc.primary_variant_id
      AND pa_ab.is_active = true AND pa_ab.deleted_at IS NULL
    JOIN product_variant pv_a ON pv_a.id = pa_ab.primary_variant_id AND pv_a.deleted_at IS NULL
    WHERE pa_bc.is_active = true AND pa_bc.deleted_at IS NULL
      -- skip self-referential (handled above)
      AND pa_bc.primary_variant_id <> pa_bc.alt_variant_id
    ORDER BY pv_a.sku, pv_b.sku, pv_c.sku
  `);

  console.log(`── Chain entries (B is alt of A, B is also primary of C): ${chains.length}`);

  if (chains.length === 0) {
    console.log("  → None found.\n");
    await db.end();
    return;
  }

  // Group by A for readability
  const byA = new Map<string, typeof chains>();
  for (const r of chains) {
    const key = r.a_sku;
    if (!byA.has(key)) byA.set(key, []);
    byA.get(key)!.push(r);
  }

  for (const [aSku, entries] of byA) {
    console.log(`\n  Primary A: ${aSku}`);
    for (const e of entries) {
      const promote = PROMOTE ? " → will be promoted to direct alt of A" : "";
      console.log(`    chain: ${aSku} → ${e.b_sku} → ${e.c_sku}${promote}`);
      console.log(`      [chain_link: ${e.chain_link_id}]  [a_link: ${e.a_link_id}]`);
    }
  }

  if (!APPLY) {
    console.log(`\n→ DRY-RUN: would process ${chains.length} chain entries.`);
    console.log("  Run with APPLY=true to fix. Add PROMOTE=true to move C → A before deactivating B→C.");
    await db.end();
    return;
  }

  // ── APPLY ──────────────────────────────────────────────────────────────────
  let promoted = 0;
  let deactivated = 0;

  for (const r of chains) {
    if (PROMOTE) {
      // Check if A → C link already exists
      const { rows: existing } = await db.query(
        `SELECT id FROM product_alternative
         WHERE primary_variant_id = $1 AND alt_variant_id = $2
           AND deleted_at IS NULL`,
        [r.a_variant_id, r.c_variant_id]
      );

      if (existing.length > 0) {
        // Reactivate if soft-deleted
        await db.query(
          `UPDATE product_alternative SET is_active = true, updated_at = now()
           WHERE primary_variant_id = $1 AND alt_variant_id = $2 AND deleted_at IS NULL`,
          [r.a_variant_id, r.c_variant_id]
        );
        console.log(`  reactivated existing A(${r.a_sku}) → C(${r.c_sku})`);
      } else {
        const newId = `palt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        await db.query(
          `INSERT INTO product_alternative
             (id, primary_variant_id, alt_variant_id, priority, is_active, created_at, updated_at)
           VALUES ($1, $2, $3, 99, true, now(), now())`,
          [newId, r.a_variant_id, r.c_variant_id]
        );
        console.log(`  promoted  A(${r.a_sku}) → C(${r.c_sku})  [new link: ${newId}]`);
        promoted++;
      }
    }

    // Deactivate B → C (chain link)
    await db.query(
      `UPDATE product_alternative SET is_active = false, updated_at = now() WHERE id = $1`,
      [r.chain_link_id]
    );
    console.log(`  deactivated  B(${r.b_sku}) → C(${r.c_sku})  [link: ${r.chain_link_id}]`);
    deactivated++;
  }

  console.log(`\n✓ Done.`);
  if (PROMOTE) console.log(`  Promoted: ${promoted} new A→C links created.`);
  console.log(`  Deactivated: ${deactivated} chain links removed.`);

  await db.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
