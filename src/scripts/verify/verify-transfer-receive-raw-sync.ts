/**
 * src/scripts/verify/verify-transfer-receive-raw-sync.ts
 *
 * E2E proof that onPoReceiveApplied/onPoReceiveReversed keep the numeric AND
 * raw_ China columns in lockstep, gate the decrement to transfer lines, and
 * reverse cleanly. Run against the SANDBOX only.
 *
 *   env DATABASE_URL=postgresql://postgres:sandbox@localhost:5499/medusa \
 *   REDIS_URL=redis://localhost:6399 MEILISEARCH_HOST=http://localhost:7799 \
 *   MEILISEARCH_API_KEY=sandbox_master_key QB_BRIDGE_URL=http://localhost:9999/disabled \
 *   yarn medusa exec ./src/scripts/verify/verify-transfer-receive-raw-sync.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";
import {
  onPoReceiveApplied,
  onPoReceiveReversed,
} from "../../lib/inventory-transfer-link";

const CN = "sloc_01KQ14C1CFX30EDD722BF87HDM";

interface KnexRaw {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows: unknown[]; rowCount?: number }>;
}

async function chinaLevel(knex: KnexRaw, itemId: string) {
  const r = (
    await knex.raw(
      `SELECT stocked_quantity AS num, (raw_stocked_quantity->>'value')::numeric AS raw
         FROM inventory_level WHERE inventory_item_id=? AND location_id=? AND deleted_at IS NULL`,
      [itemId, CN]
    )
  ).rows as Array<{ num: number; raw: number }>;
  return r[0];
}

export default async function verify({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const knex = container.resolve(
    ContainerRegistrationKeys.PG_CONNECTION
  ) as unknown as KnexRaw;

  const line = (
    await knex.raw(
      `SELECT it.linked_purchase_order_id AS po_id, itl.product_variant_id, pvii.inventory_item_id, itl.qty_received
         FROM inventory_transfer it
         JOIN inventory_transfer_line itl ON itl.transfer_id=it.id AND itl.deleted_at IS NULL
         JOIN product_variant_inventory_item pvii ON pvii.variant_id=itl.product_variant_id AND pvii.deleted_at IS NULL
         JOIN inventory_level il ON il.inventory_item_id=pvii.inventory_item_id AND il.location_id=? AND il.deleted_at IS NULL
        WHERE it.status='shipped' AND it.deleted_at IS NULL AND itl.qty_received < itl.qty
        LIMIT 1`,
      [CN]
    )
  ).rows[0] as {
    po_id: string;
    product_variant_id: string;
    inventory_item_id: string;
    qty_received: number;
  };
  if (!line) {
    logger.error("No shipped transfer line available in sandbox — cannot verify.");
    return;
  }

  // A control inventory item that is NOT part of this transfer.
  const control = (
    await knex.raw(
      `SELECT il.inventory_item_id
         FROM inventory_level il
        WHERE il.location_id=? AND il.deleted_at IS NULL
          AND il.inventory_item_id <> ?
          AND il.inventory_item_id NOT IN (
            SELECT pvii.inventory_item_id FROM inventory_transfer it
            JOIN inventory_transfer_line itl ON itl.transfer_id=it.id
            JOIN product_variant_inventory_item pvii ON pvii.variant_id=itl.product_variant_id
            WHERE it.linked_purchase_order_id=?
          )
        LIMIT 1`,
      [CN, line.inventory_item_id, line.po_id]
    )
  ).rows[0] as { inventory_item_id: string };

  const RECV = 2;
  const CTRL = 3;
  const before = await chinaLevel(knex, line.inventory_item_id);
  const ctrlBefore = await chinaLevel(knex, control.inventory_item_id);

  // Apply: receive RECV of the IT line + CTRL of a China-backed variant NOT on
  // the IT. Both must be deducted (every transfer PO line is a China item) and
  // both columns must move in lockstep.
  await onPoReceiveApplied(knex, line.po_id, [
    { inventory_item_id: line.inventory_item_id, product_variant_id: line.product_variant_id, qty: RECV },
    { inventory_item_id: control.inventory_item_id, product_variant_id: "variant_not_on_it", qty: CTRL },
  ]);

  const after = await chinaLevel(knex, line.inventory_item_id);
  const ctrlAfter = await chinaLevel(knex, control.inventory_item_id);

  const checks: Array<[string, boolean]> = [
    [`IT-line numeric dropped by ${RECV}`, Number(after.num) === Number(before.num) - RECV],
    [`IT-line raw dropped by ${RECV}`, Number(after.raw) === Number(before.raw) - RECV],
    [`IT-line numeric === raw (lockstep)`, Number(after.num) === Number(after.raw)],
    [`NON-IT China line ALSO deducted by ${CTRL}`, Number(ctrlAfter.num) === Number(ctrlBefore.num) - CTRL],
    [`NON-IT China line numeric === raw (lockstep)`, Number(ctrlAfter.num) === Number(ctrlAfter.raw)],
  ];

  // Reverse both to restore sandbox state.
  await onPoReceiveReversed(knex, line.po_id, [
    { inventory_item_id: line.inventory_item_id, product_variant_id: line.product_variant_id, qty: RECV },
    { inventory_item_id: control.inventory_item_id, product_variant_id: "variant_not_on_it", qty: CTRL },
  ]);
  const restored = await chinaLevel(knex, line.inventory_item_id);
  const ctrlRestored = await chinaLevel(knex, control.inventory_item_id);
  checks.push([
    `reverse restored both items' numeric+raw & in lockstep`,
    Number(restored.num) === Number(before.num) &&
      Number(restored.raw) === Number(before.raw) &&
      Number(ctrlRestored.num) === Number(ctrlBefore.num) &&
      Number(ctrlRestored.raw) === Number(ctrlBefore.raw),
  ]);

  let pass = true;
  for (const [name, ok] of checks) {
    logger.info(`  ${ok ? "✅" : "❌"} ${name}`);
    if (!ok) pass = false;
  }
  logger.info(
    `\n${pass ? "✅ ALL CHECKS PASSED" : "❌ FAILURES"} — item=${line.inventory_item_id} before(num/raw)=${before.num}/${before.raw} after=${after.num}/${after.raw} restored=${restored.num}/${restored.raw}`
  );
}
