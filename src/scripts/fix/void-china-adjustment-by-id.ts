/**
 * Void a China adjustment by id — reverses each line's net delta on LIVE stock
 * (movement-invariant, same as POST /admin/china-adjustment/:id/void) + marks
 * voided_at + Meili sync. Terminal.
 *
 *   ADJ_ID=chadj_xxx APPLY=1 env DATABASE_URL=$(grep ^DATABASE_URL= .env|cut -d= -f2-) \
 *     yarn medusa exec ./src/scripts/fix/void-china-adjustment-by-id.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";
import { syncInventoryItemToMeiliSearchWorkflow } from "../../workflows/sync-inventory-item-meilisearch";

const CHINA_LOC = "sloc_01KQ14C1CFX30EDD722BF87HDM";

interface KnexLike {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number }>;
}
interface InventoryLike {
  adjustInventory: (id: string, loc: string, adj: number) => Promise<void>;
}

export default async function run({ container }: ExecArgs) {
  const apply = process.env.APPLY === "1";
  const id = process.env.ADJ_ID;
  if (!id) { console.error("ADJ_ID required"); return; }
  const inventoryService = container.resolve(Modules.INVENTORY) as unknown as InventoryLike;
  const knex = container.resolve("__pg_connection__") as unknown as KnexLike;

  const doc = (await knex.raw(`SELECT id, notes, voided_at FROM china_adjustment WHERE id=?`, [id]))
    .rows[0] as { notes: string; voided_at: string | null } | undefined;
  if (!doc) { console.error(`Adjustment ${id} not found`); return; }
  if (doc.voided_at) { console.error(`Already voided at ${doc.voided_at}`); return; }

  const lines = (await knex.raw(
    `SELECT inventory_item_id, sku, delta FROM china_adjustment_line WHERE china_adjustment_id=?`, [id]
  )).rows as Array<{ inventory_item_id: string; sku: string; delta: number }>;

  console.log(`\n↩️  Void ${id} — "${doc.notes}" — ${apply ? "APPLY" : "DRY-RUN"}`);
  for (const l of lines) console.log(`  reverse ${l.sku.padEnd(22)} delta ${l.delta} → apply ${-l.delta}`);
  console.log(`\n${lines.length} lines`);
  if (!apply) { console.log("DRY-RUN — no writes.\n"); return; }

  const claim = (await knex.raw(
    `UPDATE china_adjustment SET voided_at=now(), void_reason=? WHERE id=? AND voided_at IS NULL`,
    ["Reverted: zeroing non-Excel China SKUs was incorrect (received products remain)", id]
  )) as { rowCount?: number };
  if ((claim.rowCount ?? 0) === 0) { console.error("Lost void race — already voided."); return; }

  for (const l of lines) await inventoryService.adjustInventory(l.inventory_item_id, CHINA_LOC, -l.delta);
  let synced = 0;
  for (const l of lines) {
    try { await syncInventoryItemToMeiliSearchWorkflow(container).run({ input: { inventoryItemId: l.inventory_item_id } }); synced++; }
    catch (err) { console.warn(`⚠️  Meili ${l.sku}: ${(err as Error).message}`); }
  }
  console.log(`\n✅ VOIDED ${id} · reversed ${lines.length} lines · Meili ${synced}/${lines.length}\n`);
}
