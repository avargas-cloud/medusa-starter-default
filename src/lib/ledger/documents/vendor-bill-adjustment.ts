import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { getBusinessDateString, pgDateToIso } from "../../date/et";
import { loadPurchaseAccountMap } from "../accounts";
import {
  buildVendorBillAdjustmentLines,
  type VendorBillAdjustmentDirection,
} from "../lines/vendor-bill-adjustment";
import { postDocumentJournal, reverseDocumentJournal } from "../post";
import {
  LedgerAccount,
  LedgerError,
  PostResult,
  ReverseResult,
} from "../types";

/**
 * ap-rounding-cleanup-20260916: GL document for `vendor_bill_adjustment`
 * (sibling of `rounding.ts`). Posts on `adjustment_date` — the historical
 * cleanup is dated at the ledger cutover, never in 2025 — and reverses on the
 * void day. No QuickBooks document exists for it, on purpose.
 */

type AdjustmentRow = {
  id: string;
  vendor_bill_id: string;
  kind: string;
  direction: string;
  amount_cents: number | string;
  account_list_id: string;
  adjustment_date: Date | string;
  created_at: string;
  voided_at: string | null;
};

async function loadRow(
  client: PoolClient,
  id: string
): Promise<AdjustmentRow | null> {
  const { rows } = await client.query<AdjustmentRow>(
    `SELECT id, vendor_bill_id, kind, direction, amount_cents, account_list_id,
            adjustment_date, created_at::text, voided_at::text
       FROM vendor_bill_adjustment WHERE id = $1 AND deleted_at IS NULL`,
    [id]
  );
  return rows[0] ?? null;
}

async function loadAdjustmentAccount(
  client: PoolClient,
  qbListId: string
): Promise<LedgerAccount> {
  const { rows } = await client.query<{
    qb_list_id: string;
    name: string;
    account_type: string;
    normal_balance: string | null;
  }>(
    `SELECT qb_list_id, name, account_type, normal_balance FROM qb_account
      WHERE qb_list_id = $1 AND is_active = true LIMIT 1`,
    [qbListId]
  );
  const row = rows[0];
  if (!row) throw new LedgerError("GL_ACCOUNT_MAP_MISSING", { qbListId });
  return {
    id: row.qb_list_id,
    name: row.name,
    account_type: row.account_type,
    currency: "USD",
    normal_balance:
      row.normal_balance === "debit" || row.normal_balance === "credit"
        ? row.normal_balance
        : null,
  };
}

export async function postVendorBillAdjustment(
  client: PoolClient,
  adjustmentId: string,
  actorId: string
): Promise<PostResult> {
  const row = await loadRow(client, adjustmentId);
  if (!row) throw new LedgerError("GL_SOURCE_INVALID", { adjustmentId });
  if (row.voided_at)
    throw new LedgerError("GL_SOURCE_INVALID", { voided: true });
  if (row.direction !== "decrease_ap" && row.direction !== "increase_ap")
    throw new LedgerError("GL_SOURCE_INVALID", { direction: row.direction });
  const map = await loadPurchaseAccountMap(client);
  const account = await loadAdjustmentAccount(client, row.account_list_id);
  const lines = buildVendorBillAdjustmentLines(
    {
      amountCents: BigInt(row.amount_cents),
      direction: row.direction as VendorBillAdjustmentDirection,
      account,
    },
    map
  );
  const day = pgDateToIso(row.adjustment_date);
  const sourceSnapshot = { row: { ...row, adjustment_date: day } };
  const sourceHash = createHash("sha256")
    .update(JSON.stringify(sourceSnapshot))
    .digest("hex");
  return postDocumentJournal(client, {
    source_kind: "vendor_bill_adjustment",
    source_id: adjustmentId,
    document_number: adjustmentId,
    day,
    reference: adjustmentId,
    description: `Vendor bill ${row.kind.replace("_", " ")} adjustment ${adjustmentId}`,
    lines,
    source_snapshot: sourceSnapshot,
    source_hash: sourceHash,
    actor_id: actorId,
  });
}

export async function reverseVendorBillAdjustment(
  client: PoolClient,
  adjustmentId: string,
  actorId: string,
  reason = "vendor bill adjustment voided"
): Promise<ReverseResult> {
  const row = await loadRow(client, adjustmentId);
  if (!row) return { status: "nothing_to_reverse" };
  const day = row.voided_at
    ? getBusinessDateString(row.voided_at)
    : pgDateToIso(row.adjustment_date);
  return reverseDocumentJournal(client, {
    source_kind: "vendor_bill_adjustment",
    source_id: adjustmentId,
    day,
    reason,
    actor_id: actorId,
  });
}
