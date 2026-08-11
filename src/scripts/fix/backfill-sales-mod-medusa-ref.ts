/**
 * Backfill medusa_ref_number en filas mod del lane append-only que nacieron
 * sin REF (2026-08-07 → 2026-08-11: callers writePipelineRow intent:"mod" que
 * no threadeaban medusaRefNumber — post-edit-sync y sync-pos).
 *
 * Alcance duro: SOLO estimate_mod / sales_order_mod con REF NULL/'' y order_id
 * presente. Deriva E/S + "order".display_id — la misma regla que el fallback
 * del INSERT. No toca ninguna otra columna.
 *
 * Dry-run por default; APPLY=true escribe. Imprime snapshot previo (id → valor
 * viejo) para rollback trivial.
 *
 * Correr:
 *   env DATABASE_URL=... ./node_modules/.bin/tsx src/scripts/fix/backfill-sales-mod-medusa-ref.ts
 *   env DATABASE_URL=... APPLY=true ./node_modules/.bin/tsx src/scripts/fix/backfill-sales-mod-medusa-ref.ts
 */
import { Pool } from "pg";

const APPLY = process.env.APPLY === "true";

const CANDIDATES_SQL = `
  SELECT p.seq, p.id, p.step, p.status, p.order_id,
         p.medusa_ref_number AS old_ref,
         CASE WHEN p.step = 'estimate_mod' THEN 'E' ELSE 'S' END
           || o.display_id::text AS new_ref,
         to_char(p.created_at, 'YYYY-MM-DD HH24:MI') AS created
    FROM qb_order_pipeline p
    JOIN "order" o ON o.id = p.order_id
   WHERE p.step IN ('estimate_mod', 'sales_order_mod')
     AND (p.medusa_ref_number IS NULL OR p.medusa_ref_number = '')
     AND p.order_id IS NOT NULL
   ORDER BY p.seq`;

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const { rows } = await pool.query(CANDIDATES_SQL);
    console.log(`Candidatas: ${rows.length} filas ${APPLY ? "(APPLY)" : "(dry-run)"}\n`);
    for (const r of rows) {
      console.log(
        `#${r.seq} ${r.step} [${r.status}] ${r.created} order=${r.order_id} ` +
          `ref: ${JSON.stringify(r.old_ref)} → "${r.new_ref}"`
      );
    }
    if (!APPLY) {
      console.log("\nDry-run — nada escrito. APPLY=true para aplicar.");
      return;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const upd = await client.query(
        `UPDATE qb_order_pipeline p
            SET medusa_ref_number =
                  (SELECT CASE WHEN p.step = 'estimate_mod' THEN 'E' ELSE 'S' END
                            || o.display_id::text
                     FROM "order" o WHERE o.id = p.order_id)
          WHERE p.step IN ('estimate_mod', 'sales_order_mod')
            AND (p.medusa_ref_number IS NULL OR p.medusa_ref_number = '')
            AND p.order_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM "order" o WHERE o.id = p.order_id)
        RETURNING p.seq, p.medusa_ref_number`,
      );
      if (upd.rowCount !== rows.length) {
        await client.query("ROLLBACK");
        console.error(
          `❌ ABORT: el UPDATE tocaría ${upd.rowCount} filas y el preview mostró ${rows.length} — rollback.`
        );
        process.exit(1);
      }
      await client.query("COMMIT");
      console.log(`\n✅ ${upd.rowCount} filas actualizadas.`);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}
main().catch((e) => { console.error("❌", e.message); process.exit(1); });
