/**
 * src/lib/qb-backfill/relink-bills.ts
 *
 * Fix del backfill de compras (plan `qb-docs-backfill-compras-20260911`):
 * `applyBills` resuelve el PO local de un bill contra el índice de POs *en
 * el momento en que corrió* (`resolveLocalPoByLinkedTxns`). Los POs de 2025
 * llegaron DESPUÉS por `follow-links.ts`, así que algunos bills quedaron con
 * `vendor_bill.purchase_order_id IS NULL` y sus líneas de producto sin
 * `purchase_order_line_id` aunque el `LinkedTxn` (TxnType `PurchaseOrder`)
 * del bill en QB apunta a un PO que HOY existe en
 * `purchase_order.qb_purchase_order_list_id`.
 *
 * Este módulo relinkea esos bills: setea `purchase_order_id` en el header y
 * matchea las líneas de producto sueltas contra las líneas abiertas del PO
 * (mismo criterio greedy que `insertBillLines` en `create-bill.ts`). NO toca
 * amounts/costs/status/stock/pipeline — sólo los dos FKs y `notes` (marcador
 * de auditoría, APENDEADO, nunca reemplaza lo que ya había).
 *
 * `planBillRelinks` es PURO (sin IO): recibe los bills de la caché QB, las
 * filas de `vendor_bill` con `purchase_order_id IS NULL`, y el índice de
 * POs/números ya cargados — decide qué relinkear sin tocar Postgres, para
 * poder testearlo sin levantar una DB.
 */
import { matchPoLineForVariant, type OpenPoLine } from "./links";
import { resolveLocalPoByLinkedTxns, type PoIndexEntry } from "./apply-purchases";
import type { QueryableDb } from "./resolve";
import type { QbBill } from "./types";

export interface BillRelinkRow {
  id: string;
  qb_txn_id: string;
  purchase_order_id: string | null;
}

export interface PlannedBillRelink {
  vendor_bill_id: string;
  qb_txn_id: string;
  po_id: string;
  po_number: string;
}

/**
 * `billRows` con `purchase_order_id` no-NULL se saltean (ya enlazados —
 * el caller puede pasar el universo entero o sólo los NULL, el filtro es
 * acá para que el test unitario cubra el caso "ya seteado" sin depender de
 * que el SQL del caller lo excluya). Un bill sin caché QB (`qb_txn_id` no
 * está entre `bills`), sin `LinkedTxn` tipo `PurchaseOrder`, o cuyo PO
 * enlazado no existe (todavía) en `poIndex` — se saltea, no bloquea nada.
 */
export function planBillRelinks(
  bills: readonly QbBill[],
  billRows: readonly BillRelinkRow[],
  poIndex: ReadonlyMap<string, PoIndexEntry>,
  poNumberById: ReadonlyMap<string, string>
): PlannedBillRelink[] {
  const billByTxnId = new Map(bills.map((b) => [b.txn_id, b]));
  const out: PlannedBillRelink[] = [];
  for (const row of billRows) {
    if (row.purchase_order_id !== null) continue;
    const bill = billByTxnId.get(row.qb_txn_id);
    if (!bill) continue;
    const po = resolveLocalPoByLinkedTxns(bill.linked_txns, poIndex as Map<string, PoIndexEntry>);
    if (!po) continue;
    out.push({
      vendor_bill_id: row.id,
      qb_txn_id: row.qb_txn_id,
      po_id: po.id,
      po_number: poNumberById.get(po.id) ?? po.id,
    });
  }
  return out;
}

/** `purchase_order.id → number`, para el marcador de notes y el reporte del plan. */
export async function loadPoNumberIndex(client: QueryableDb): Promise<Map<string, string>> {
  const { rows } = await client.query(`SELECT id, number FROM purchase_order WHERE deleted_at IS NULL`);
  const map = new Map<string, string>();
  for (const r of rows as { id: string; number: string }[]) map.set(String(r.id), String(r.number));
  return map;
}

/** Reindexa `PoIndexEntry.lines` por `purchase_order.id` (el `poIndex` de `apply-purchases.ts` va por ListID de QB) — así el driver puede resolver las líneas abiertas de un `po_id` ya conocido sin recorrer el Map entero. */
export function indexPoLinesById(poIndex: ReadonlyMap<string, PoIndexEntry>): Map<string, OpenPoLine[]> {
  const map = new Map<string, OpenPoLine[]>();
  for (const entry of poIndex.values()) map.set(entry.id, entry.lines);
  return map;
}

export interface ApplyBillRelinkResult {
  lines_matched: number;
}

/**
 * Setea `purchase_order_id` en el header y matchea las líneas de producto
 * sin `purchase_order_line_id` contra `poLines` (greedy, mismo criterio que
 * `insertBillLines`: cada línea del PO acumula lo asignado DENTRO de esta
 * llamada — `already_matched` arranca en 0 por línea de PO en cada bill,
 * igual que hace `create-bill.ts` por documento). Transacción propia: si
 * cualquier UPDATE falla, revierte y relanza — el caller reporta el bill
 * como bloqueado sin detener el resto del run.
 */
export async function applyBillRelink(
  client: QueryableDb,
  relink: PlannedBillRelink,
  poLines: readonly OpenPoLine[],
  runId: string
): Promise<ApplyBillRelinkResult> {
  // El marcador lleva el bill_type previo: `deriveBillType(resolvedPoId)` lo
  // congeló en 'expense' cuando el PO todavía no existía, y `billed-status.ts`
  // sólo cuenta bills 'regular' → sin este flip el PO seguiría "Billed: No".
  // Se registra para que el rollback lo restaure exacto.
  const marker = ` [qb_backfill relink ${runId}: po=${relink.po_number} bill_type_was=__TYPE__]`;
  try {
    await client.query("BEGIN");
    const { rows: prev } = await client.query(`SELECT bill_type, notes FROM vendor_bill WHERE id = $1`, [relink.vendor_bill_id]);
    const prevType = String((prev[0] as { bill_type: string | null } | undefined)?.bill_type ?? "");
    const prevNotes = String((prev[0] as { notes: string | null } | undefined)?.notes ?? "");
    const finalMarker = marker.replace("__TYPE__", prevType || "null");
    // Idempotente: un bill que ya lleva el marcador de este run no lo duplica.
    const notes = prevNotes.includes(`[qb_backfill relink ${runId}: po=`) ? prevNotes : prevNotes + finalMarker;
    await client.query(
      `UPDATE vendor_bill
          SET purchase_order_id = $1,
              bill_type = CASE WHEN bill_type = 'expense' THEN 'regular' ELSE bill_type END,
              notes = $2,
              updated_at = now()
        WHERE id = $3`,
      [relink.po_id, notes, relink.vendor_bill_id]
    );

    const { rows } = await client.query(
      `SELECT id, product_variant_id, qty FROM vendor_bill_line
        WHERE vendor_bill_id = $1
          AND line_type = 'product'
          AND product_variant_id IS NOT NULL
          AND purchase_order_line_id IS NULL
        ORDER BY id ASC`,
      [relink.vendor_bill_id]
    );

    const assignedQtyByPoLine = new Map<string, number>();
    let linesMatched = 0;
    for (const line of rows as { id: string; product_variant_id: string; qty: string | number }[]) {
      const qty = Number(line.qty);
      const openLines: OpenPoLine[] = poLines.map((l) => ({
        ...l,
        already_matched: assignedQtyByPoLine.get(l.id) ?? 0,
      }));
      const matched = matchPoLineForVariant(openLines, line.product_variant_id, qty);
      if (!matched) continue;
      assignedQtyByPoLine.set(matched.id, (assignedQtyByPoLine.get(matched.id) ?? 0) + qty);
      await client.query(
        `UPDATE vendor_bill_line SET purchase_order_line_id = $1, updated_at = now() WHERE id = $2`,
        [matched.id, line.id]
      );
      linesMatched++;
    }

    await client.query("COMMIT");
    return { lines_matched: linesMatched };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface RollbackBillRelinkResult {
  bills_reverted: number;
  lines_reverted: number;
}

/**
 * Revierte `applyBillRelink` por marcador: bills cuyo `notes` contiene
 * `[qb_backfill relink <runId>: po=…]` vuelven a `purchase_order_id = NULL`,
 * sus líneas de producto a `purchase_order_line_id = NULL`, y el marcador
 * se quita de `notes` (el resto del texto —el de la corrida original del
 * backfill, si lo hay— se preserva intacto).
 */
export async function rollbackBillRelink(client: QueryableDb, runId: string): Promise<RollbackBillRelinkResult> {
  const markerRe = new RegExp(` ?\\[qb_backfill relink ${escapeRegExp(runId)}: po=[^\\]]*\\]`, "g");
  const typeRe = new RegExp(`\\[qb_backfill relink ${escapeRegExp(runId)}: po=[^\\]]*?bill_type_was=([a-z_]+|null)\\]`);
  const { rows } = await client.query(
    `SELECT id, notes FROM vendor_bill
      WHERE deleted_at IS NULL AND notes LIKE $1`,
    [`%[qb_backfill relink ${runId}: po=%`]
  );

  let billsReverted = 0;
  let linesReverted = 0;
  for (const row of rows as { id: string; notes: string | null }[]) {
    const cleanedNotes = (row.notes ?? "").replace(markerRe, "");
    const typeMatch = typeRe.exec(row.notes ?? "");
    const prevType = typeMatch && typeMatch[1] !== "null" ? typeMatch[1] : null;
    try {
      await client.query("BEGIN");
      const { rows: revertedLines } = await client.query(
        `UPDATE vendor_bill_line
            SET purchase_order_line_id = NULL, updated_at = now()
          WHERE vendor_bill_id = $1 AND line_type = 'product' AND purchase_order_line_id IS NOT NULL
          RETURNING id`,
        [row.id]
      );
      await client.query(
        `UPDATE vendor_bill
            SET purchase_order_id = NULL,
                bill_type = COALESCE($3, bill_type),
                notes = $2,
                updated_at = now()
          WHERE id = $1`,
        [row.id, cleanedNotes, prevType]
      );
      await client.query("COMMIT");
      billsReverted++;
      linesReverted += revertedLines.length;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  }
  return { bills_reverted: billsReverted, lines_reverted: linesReverted };
}
