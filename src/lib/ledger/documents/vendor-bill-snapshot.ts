import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

import {
  VENDOR_BILL_LINE_CENTS,
  VENDOR_BILL_PERIOD_COST_SCOPE_SQL,
} from "../../../api/admin/reports/_lib/period-costs";
import { loadPurchaseAccountMap } from "../accounts";
import { VendorBillClassifiedLine } from "../lines/vendor-bill";
import { LedgerAccount } from "../types";

/**
 * documents/vendor-bill-snapshot.ts — loaders + hash de `vendor-bill.ts`,
 * separados a un archivo propio para no pasar el límite de 300 líneas del
 * repo (CLAUDE.md §G). `vendor-bill.ts` conserva `post*`/`reverse*` (la API
 * pública del documento); esto es su lectura de datos.
 */

export type BillHeader = {
  id: string;
  number: string | null;
  status: string;
  bill_type: string;
  qb_amount_due_cents: number | null;
  document_date: string | null;
  confirmed_at: string | null;
  active_revision_id: string | null;
};

export type BillLineRow = {
  id: string;
  line_type: string;
  qb_account_list_id: string | null;
  landed_total_cents: number | null;
  line_cents: string;
  in_scope: boolean;
};

export type ReceiptRow = {
  id: string;
  qty_received_now: number;
  unit_cost_cents_override: string | null;
  po_line_unit_cost_cents: string;
};

export async function loadHeader(client: PoolClient, billId: string): Promise<BillHeader | null> {
  const { rows } = await client.query<BillHeader>(
    `SELECT id, number, status, bill_type, qb_amount_due_cents,
            document_date::text, confirmed_at::text, active_revision_id
     FROM vendor_bill WHERE id = $1 AND deleted_at IS NULL`,
    [billId]
  );
  return rows[0] ?? null;
}

/** `vendor_bill` no tiene `cancelled_at`/`voided_at` propios — `updated_at` es el mejor proxy del momento del cambio de estado. */
export async function loadUpdatedAt(client: PoolClient, billId: string): Promise<string | null> {
  const { rows } = await client.query<{ updated_at: string }>(
    `SELECT updated_at::text FROM vendor_bill WHERE id = $1`,
    [billId]
  );
  return rows[0]?.updated_at ?? null;
}

/**
 * `in_scope` reusa TEXTUALMENTE `VENDOR_BILL_PERIOD_COST_SCOPE_SQL` — la
 * misma regla que decide qué es gasto del período en `reports/_lib/period-costs.ts`.
 * `in_scope = true` → gasto del período (se expensa a su propia cuenta);
 * `in_scope = false` → capitaliza a `inventory_asset` (§1: "el GL usa
 * exactamente esa función").
 */
export async function loadLines(client: PoolClient, billId: string): Promise<BillLineRow[]> {
  const { rows } = await client.query<BillLineRow>(
    `SELECT l.id, l.line_type, l.qb_account_list_id, l.landed_total_cents,
            ${VENDOR_BILL_LINE_CENTS} AS line_cents,
            (${VENDOR_BILL_PERIOD_COST_SCOPE_SQL}) AS in_scope
     FROM vendor_bill_line l
     JOIN vendor_bill vb ON vb.id = l.vendor_bill_id
     WHERE l.vendor_bill_id = $1 AND l.deleted_at IS NULL
     ORDER BY l.id`,
    [billId]
  );
  return rows;
}

/** Receipts D6-atados a este bill (`purchase_order_receipt.vendor_bill_id`), valuados a costo de RECEPCIÓN. */
export async function loadBoundReceipts(client: PoolClient, billId: string): Promise<ReceiptRow[]> {
  // ROUND en SQL — `unit_cost_cents`/`_override` son `float` (mismo defecto
  // que `documents/receipt.ts`, medido contra `medusa_gl`: `69.8`); `BigInt`
  // de un decimal explota.
  const { rows } = await client.query<ReceiptRow>(
    `SELECT por.id,
            rl.qty_received_now,
            ROUND(rl.unit_cost_cents_override::numeric)::bigint::text AS unit_cost_cents_override,
            ROUND(pol.unit_cost_cents::numeric)::bigint::text AS po_line_unit_cost_cents
     FROM purchase_order_receipt por
     JOIN purchase_order_receipt_line rl ON rl.purchase_order_receipt_id = por.id
     JOIN purchase_order_line pol ON pol.id = rl.purchase_order_line_id
     WHERE por.vendor_bill_id = $1 AND por.deleted_at IS NULL AND por.voided_at IS NULL`,
    [billId]
  );
  return rows;
}

/**
 * Σ true-up ACTIVO — leído de `variant_cost_event` (lo que el confirm ya
 * registró), nunca recomputado (§2 "sólo si el confirm lo registró").
 */
async function loadTrueUpCents(client: PoolClient, billId: string): Promise<bigint> {
  const { rows } = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(cogs_true_up_cents), 0)::bigint::text AS total
     FROM variant_cost_event
     WHERE vendor_bill_id = $1 AND event_type = 'vendor_bill_receipt' AND status = 'active'`,
    [billId]
  );
  return BigInt(rows[0]?.total ?? "0");
}

async function resolveAccounts(
  client: PoolClient,
  listIds: string[]
): Promise<Map<string, LedgerAccount>> {
  const ids = [...new Set(listIds)].filter(Boolean);
  const result = new Map<string, LedgerAccount>();
  if (!ids.length) return result;
  const { rows } = await client.query<{
    qb_list_id: string;
    name: string;
    account_type: string;
    normal_balance: string | null;
  }>(
    `SELECT qb_list_id, name, account_type, normal_balance FROM qb_account
     WHERE qb_list_id = ANY($1::text[])`,
    [ids]
  );
  for (const r of rows) {
    result.set(r.qb_list_id, {
      id: r.qb_list_id,
      name: r.name,
      account_type: r.account_type,
      currency: "USD",
      normal_balance:
        r.normal_balance === "debit" || r.normal_balance === "credit" ? r.normal_balance : null,
    });
  }
  return result;
}

export async function buildSnapshot(client: PoolClient, header: BillHeader) {
  const map = await loadPurchaseAccountMap(client);
  const lineRows = await loadLines(client, header.id);

  if (lineRows.length === 0) {
    const amount = BigInt(header.qb_amount_due_cents ?? 0);
    return {
      map,
      lineRows,
      receipts: [] as ReceiptRow[],
      trueUpCents: 0n,
      vendorBillSnapshot: {
        payableCents: 0n,
        offsetCents: 0n,
        trueUpCents: 0n,
        expensedLines: [] as VendorBillClassifiedLine[],
        adoptedNoLines: { qbAmountDueCents: amount },
      },
    };
  }

  const accountsByListId = await resolveAccounts(
    client,
    lineRows.map((r) => r.qb_account_list_id).filter((x): x is string => Boolean(x))
  );
  const expensedLines: VendorBillClassifiedLine[] = lineRows
    .filter((r) => r.line_type === "qb_account" && r.in_scope && r.qb_account_list_id)
    .map((r) => ({
      account: accountsByListId.get(r.qb_account_list_id as string) ?? map.income_default,
      amountCents: BigInt(r.line_cents ?? "0"),
    }));

  const payableCents = lineRows.reduce((sum, r) => sum + BigInt(r.line_cents ?? "0"), 0n);
  const receipts = await loadBoundReceipts(client, header.id);
  const offsetCents = receipts.reduce(
    (sum, r) =>
      sum +
      BigInt(Math.trunc(r.qty_received_now)) *
        BigInt(r.unit_cost_cents_override ?? r.po_line_unit_cost_cents),
    0n
  );
  const trueUpCents = await loadTrueUpCents(client, header.id);

  return {
    map,
    lineRows,
    receipts,
    trueUpCents,
    vendorBillSnapshot: {
      payableCents,
      offsetCents,
      trueUpCents,
      expensedLines,
      adoptedNoLines: null,
    },
  };
}

/**
 * §5: el hash del snapshot INCLUYE la clasificación por línea, el
 * `landed_total_cents` de cada línea, los receipts atados (id + costo) y la
 * revisión activa — así un reconfirm (revisión, costos, o enlace de receipts)
 * cambia el hash y el reconciler dispara reversa+repost por drift.
 */
export function computeVendorBillSourceHash(input: {
  header: BillHeader;
  lineRows: BillLineRow[];
  receipts: ReceiptRow[];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        activeRevisionId: input.header.active_revision_id,
        lines: input.lineRows.map((r) => ({
          id: r.id,
          landed_total_cents: r.landed_total_cents,
          in_scope: r.in_scope,
        })),
        receipts: input.receipts.map((r) => ({
          id: r.id,
          qty: r.qty_received_now,
          cost: r.unit_cost_cents_override ?? r.po_line_unit_cost_cents,
        })),
      })
    )
    .digest("hex");
}
