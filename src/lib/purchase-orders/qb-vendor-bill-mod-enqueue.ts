import { randomUUID } from "crypto";
import {
  enqueuePurchaseQbOperation,
  purchaseOperationKey,
} from "./qb-purchase-dependency-chain";

export type VendorBillModKnex = {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows: unknown[]; rowCount?: number }>;
};

export type VendorBillModEnqueueResult =
  | { queued: true; groupId: string; billIds: string[] }
  | { queued: false; reason: string };

type BillType = "regular" | "service" | "freight" | "tariff";

interface BillRow {
  id: string;
  number: string | null;
  bill_type: BillType;
  purchase_order_id: string | null;
  reference_id: string | null;
  document_date: string | null;
  due_date: string | null;
  qb_txn_id: string | null;
  qb_edit_sequence: string | null;
  qb_source: string | null;
  qb_clearing_lines: ClearingLine[] | null;
  service_vendor_bill_id: string | null;
  freight_vendor_bill_id: string | null;
  tariff_vendor_bill_id: string | null;
  commission_amount_cents: number;
  freight_amount_cents: number;
  tariff_amount_cents: number;
}

interface ClearingLine {
  kind: "freight" | "commission" | "tariff" | "other";
  account_list_id: string;
  account_full_name?: string;
  amount_cents: number;
  qb_txn_line_id: string;
}

function dateValue(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function loadBill(
  db: VendorBillModKnex,
  id: string
): Promise<BillRow | null> {
  const result = await db.raw(
    `SELECT id, number, bill_type, purchase_order_id, reference_id,
            document_date, due_date, qb_txn_id, qb_edit_sequence, qb_source,
            qb_clearing_lines, service_vendor_bill_id, freight_vendor_bill_id,
            tariff_vendor_bill_id, commission_amount_cents,
            freight_amount_cents, tariff_amount_cents
       FROM vendor_bill
      WHERE id = ? AND deleted_at IS NULL`,
    [id]
  );
  return (result.rows[0] as unknown as BillRow | undefined) ?? null;
}

async function resolveRegularBill(
  db: VendorBillModKnex,
  editedBill: BillRow
): Promise<BillRow | null> {
  if (editedBill.bill_type === "regular") return editedBill;
  const result = await db.raw(
    `SELECT id
       FROM vendor_bill
      WHERE deleted_at IS NULL
        AND bill_type = 'regular'
        AND (? = service_vendor_bill_id
          OR ? = freight_vendor_bill_id
          OR ? = tariff_vendor_bill_id)
      LIMIT 2`,
    [editedBill.id, editedBill.id, editedBill.id]
  );
  if (result.rows.length !== 1) return null;
  return loadBill(
    db,
    String((result.rows[0] as { id: unknown }).id)
  );
}

async function loadBillTotal(
  db: VendorBillModKnex,
  id: string | null,
  fallback: number
): Promise<number> {
  if (!id) return fallback;
  const result = await db.raw(
    `SELECT COALESCE(SUM(
              CASE WHEN COALESCE(line_type, 'product') = 'product'
                THEN unit_cost_cents::bigint * qty
                ELSE COALESCE(amount_cents, unit_cost_cents)::bigint
              END
            ), 0)::bigint AS total_cents
       FROM vendor_bill_line
      WHERE vendor_bill_id = ? AND deleted_at IS NULL`,
    [id]
  );
  return Number(
    (result.rows[0] as { total_cents?: number | string } | undefined)
      ?.total_cents ?? fallback
  );
}

async function buildPayload(
  db: VendorBillModKnex,
  bill: BillRow,
  regular: BillRow,
  groupId: string
): Promise<Record<string, unknown>> {
  if (!bill.qb_txn_id || !bill.qb_edit_sequence) {
    throw new Error(`${bill.number ?? bill.id}: missing QB TxnID/EditSequence`);
  }
  if (bill.qb_source === "adopted") {
    throw new Error(`${bill.number ?? bill.id}: adopted_bill_readonly`);
  }

  const lineResult = await db.raw(
    `SELECT l.id, l.line_type, l.line_kind, l.qty,
            l.unit_cost_cents, l.landed_unit_cost_cents, l.amount_cents,
            l.qb_txn_line_id,
            COALESCE(l.freight_account_list_id, l.qb_account_list_id)
              AS account_list_id,
            pv.metadata ->> 'quickbooks_id' AS qb_item_list_id,
            l.description
       FROM vendor_bill_line l
       LEFT JOIN product_variant pv
         ON pv.id = l.product_variant_id AND pv.deleted_at IS NULL
      WHERE l.vendor_bill_id = ? AND l.deleted_at IS NULL
      ORDER BY l.created_at, l.id`,
    [bill.id]
  );

  const lineRows = lineResult.rows as Record<string, unknown>[];
  const itemLines = lineRows
    .filter((line) => String(line.line_type ?? "product") === "product")
    .map((line) => {
      if (!line.qb_txn_line_id) {
        throw new Error(
          `${bill.number ?? bill.id}: line ${String(line.id)} has no QB TxnLineID`
        );
      }
      return {
        vendor_bill_line_id: String(line.id),
        qb_txn_line_id: String(line.qb_txn_line_id),
        qb_item_list_id: line.qb_item_list_id
          ? String(line.qb_item_list_id)
          : null,
        quantity: Number(line.qty),
        unit_cost_cents:
          bill.bill_type === "regular"
            ? Number(line.landed_unit_cost_cents || line.unit_cost_cents)
            : Number(line.unit_cost_cents),
      };
    });

  const localExpenseLines = lineRows
    .filter((line) => String(line.line_type ?? "") === "qb_account")
    .map((line) => {
      if (!line.qb_txn_line_id || !line.account_list_id) {
        throw new Error(
          `${bill.number ?? bill.id}: account line ${String(line.id)} lacks QB identity`
        );
      }
      return {
        vendor_bill_line_id: String(line.id),
        qb_txn_line_id: String(line.qb_txn_line_id),
        account_list_id: String(line.account_list_id),
        amount_cents: Number(line.amount_cents ?? line.unit_cost_cents),
        memo: line.description ? String(line.description) : undefined,
      };
    });

  const retainedClearing =
    bill.bill_type === "regular"
      ? await (async () => {
          const amounts = {
            commission: await loadBillTotal(
              db,
              regular.service_vendor_bill_id,
              Number(regular.commission_amount_cents ?? 0)
            ),
            freight: await loadBillTotal(
              db,
              regular.freight_vendor_bill_id,
              Number(regular.freight_amount_cents ?? 0)
            ),
            tariff: await loadBillTotal(
              db,
              regular.tariff_vendor_bill_id,
              Number(regular.tariff_amount_cents ?? 0)
            ),
          };
          return (bill.qb_clearing_lines ?? []).map((line) => ({
            qb_txn_line_id: line.qb_txn_line_id,
            account_list_id: line.account_list_id,
            amount_cents:
              line.kind === "other"
                ? Number(line.amount_cents)
                : -amounts[line.kind],
            memo: line.account_full_name,
          }));
        })()
      : [];

  const expenseLines =
    bill.bill_type === "regular" ? retainedClearing : localExpenseLines;
  if (itemLines.length === 0 && expenseLines.length === 0) {
    throw new Error(`${bill.number ?? bill.id}: no retained QB lines`);
  }

  return {
    __mod_group_id: groupId,
    vendor_bill_id: bill.id,
    txn_id: bill.qb_txn_id,
    edit_sequence: bill.qb_edit_sequence,
    ref_number: bill.reference_id,
    txn_date: dateValue(bill.document_date),
    due_date: dateValue(bill.due_date),
    memo: `EcoPowerTech ${bill.number ?? bill.id}`,
    item_lines: itemLines,
    expense_lines: expenseLines,
  };
}

/**
 * Freezes every linked China-agency BillMod in the caller's transaction.
 * Either the whole Regular/Service/Freight/Tariff group is queued, or none is.
 */
export async function enqueueChinaAgencyVendorBillModGroup(
  db: VendorBillModKnex,
  editedBillId: string
): Promise<VendorBillModEnqueueResult> {
  if (process.env.QB_VENDOR_BILL_MODE !== "bill") {
    return { queued: false, reason: "QB_VENDOR_BILL_MODE is not 'bill'" };
  }
  const edited = await loadBill(db, editedBillId);
  if (!edited) return { queued: false, reason: "vendor bill not found" };
  if (edited.qb_source === "adopted") {
    return { queued: false, reason: "adopted_bill_readonly" };
  }
  if (!edited.qb_txn_id) {
    return { queued: false, reason: "bill is not linked to QuickBooks" };
  }
  const regular = await resolveRegularBill(db, edited);
  if (!regular) {
    return { queued: false, reason: "linked regular bill not found or ambiguous" };
  }

  const ids = [
    regular.id,
    regular.service_vendor_bill_id,
    regular.freight_vendor_bill_id,
    regular.tariff_vendor_bill_id,
  ].filter((id): id is string => Boolean(id));
  const groupId = `qbvbmodgrp_${randomUUID().replace(/-/g, "")}`;
  const bills: BillRow[] = [];
  for (const id of ids) {
    const bill = await loadBill(db, id);
    if (!bill) throw new Error(`Linked vendor bill ${id} was not found`);
    bills.push(bill);
  }

  for (const bill of bills) {
    const payload = await buildPayload(db, bill, regular, groupId);
    const existing = await db.raw(
      `SELECT id, status
         FROM qb_vendor_bill_pipeline
        WHERE vendor_bill_id = ? AND deleted_at IS NULL
        FOR UPDATE`,
      [bill.id]
    );
    const row = existing.rows[0] as
      | { id: string; status: string }
      | undefined;
    if (row && ["waiting", "submitted", "error"].includes(String(row.status))) {
      throw new Error(
        `${bill.number ?? bill.id}: QuickBooks sync is already ${String(row.status)}`
      );
    }
    let vendorBillPipelineId: string;
    if (row) {
      vendorBillPipelineId = String(row.id);
      await db.raw(
        `UPDATE qb_vendor_bill_pipeline
            SET purchase_order_id = ?, status = 'waiting', intent = 'mod',
                payload = ?::jsonb, snapshot = NULL,
                qb_operation_id = NULL, qb_txn_id = ?,
                qb_ref_number = ?, edit_sequence = ?, retries = 0,
                next_retry_at = NULL, last_error = NULL, updated_at = NOW()
          WHERE id = ?`,
        [
          regular.purchase_order_id,
          JSON.stringify(payload),
          bill.qb_txn_id,
          bill.reference_id,
          bill.qb_edit_sequence,
          String(row.id),
        ]
      );
    } else {
      vendorBillPipelineId = `qbvbpipe_${randomUUID().replace(/-/g, "")}`;
      await db.raw(
        `INSERT INTO qb_vendor_bill_pipeline
           (id, vendor_bill_id, purchase_order_id, status, intent, payload,
            qb_txn_id, qb_ref_number, edit_sequence, retries, created_at, updated_at)
         VALUES (?, ?, ?, 'waiting', 'mod', ?::jsonb, ?, ?, ?, 0, NOW(), NOW())`,
        [
          vendorBillPipelineId,
          bill.id,
          regular.purchase_order_id,
          JSON.stringify(payload),
          bill.qb_txn_id,
          bill.reference_id,
          bill.qb_edit_sequence,
        ]
      );
    }

    if (!regular.purchase_order_id) {
      throw new Error(`${regular.number ?? regular.id}: missing purchase order`);
    }
    const orderPayload = {
      ...payload,
      qb_vendor_bill_pipeline_id: vendorBillPipelineId,
    };
    const operation = await enqueuePurchaseQbOperation(db, {
      purchaseOrderId: regular.purchase_order_id,
      referenceId: bill.id,
      referenceType: "vendor_bill",
      step: "vendor_bill_mod",
      qbTxnId: bill.qb_txn_id,
      payload: orderPayload,
      operationKey: purchaseOperationKey(
        "vendor_bill_mod",
        bill.id,
        orderPayload
      ),
    });
    await db.raw(
      `UPDATE qb_vendor_bill_pipeline
          SET order_pipeline_id = ?, updated_at = NOW()
        WHERE id = ?`,
      [operation.id, vendorBillPipelineId]
    );
  }
  return { queued: true, groupId, billIds: bills.map((bill) => bill.id) };
}
