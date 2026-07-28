import { getDbPool } from "../../../api/utils/db-pool";
import type { ResubmitRow } from "./resubmit-by-step";

export class PermanentPurchaseOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentPurchaseOperationError";
  }
}

export interface VendorBillRebuildCompletion {
  txnId: string | null;
  refNumber: string | null;
  editSequence: string | null;
}

export function isAlreadyMissingBillDeleteError(error: string): boolean {
  return /\b3120\b|object .*cannot be found|transaction .*not found/i.test(
    error
  );
}

export async function completeVendorBillRebuildPreflight(
  row: ResubmitRow,
  operation: Record<string, unknown>
): Promise<VendorBillRebuildCompletion> {
  const billId = row.reference_id;
  const expectedTxnId =
    stringValue(row.qb_txn_id) ?? stringValue(row.payload?.txn_id);
  if (!billId || !expectedTxnId) {
    throw new PermanentPurchaseOperationError(
      "Vendor Bill rebuild preflight is missing its Bill or QB TxnID"
    );
  }

  const messages = extractMessages(operation.result);
  const response = messages.BillQueryRs as
    | Record<string, unknown>
    | undefined;
  if (!response) {
    throw new Error(
      "Vendor Bill rebuild preflight completed without BillQueryRs"
    );
  }
  const statusCode = String(
    response.statusCode ?? response["@statusCode"] ?? "0"
  );
  const statusSeverity = String(
    response.statusSeverity ?? response["@statusSeverity"] ?? ""
  );
  const statusMessage = String(
    response.statusMessage ?? response["@statusMessage"] ?? ""
  );
  const explicitNoMatch =
    statusCode === "1" &&
    (/info/i.test(statusSeverity) || /no match|not found/i.test(statusMessage));
  if (statusCode !== "0" && !explicitNoMatch) {
    throw new Error(
      `QuickBooks BillQuery Error ${statusCode}: ${
        statusMessage || "unknown response"
      }`
    );
  }
  const candidates = toRecords(response?.BillRet);
  const bill =
    candidates.find(
      (candidate) => stringValue(candidate.TxnID) === expectedTxnId
    ) ?? null;
  if (candidates.length > 0 && !bill) {
    throw new Error(
      "Vendor Bill rebuild preflight returned a different QuickBooks Bill"
    );
  }
  const legacyId = stringValue(
    row.payload?.qb_vendor_bill_pipeline_id
  );
  const pool = getDbPool();

  if (!bill) {
    if (legacyId) {
      await pool.query(
        `UPDATE qb_vendor_bill_pipeline
            SET intent = 'rebuild_deleting', status = 'waiting',
                qb_operation_id = NULL, retries = 0,
                next_retry_at = NULL,
                last_error = 'Preflight found no QB Bill; delete will verify it is already absent',
                updated_at = NOW()
          WHERE id = $1`,
        [legacyId]
      );
    }
    return {
      txnId: expectedTxnId,
      refNumber: null,
      editSequence: null,
    };
  }

  const amountDue = finiteNumber(bill.AmountDue);
  const balanceCents = amountDue !== null
    ? Math.round(amountDue * 100)
    : null;
  const paymentState = vendorBillPaymentState(bill, amountDue);
  if (paymentState === "unknown") {
    throw new Error(
      "QuickBooks BillQuery did not return IsPaid or AmountDue; rebuild safety could not be verified"
    );
  }
  const paid = paymentState === "paid";
  const editSequence = stringValue(bill.EditSequence);
  const refNumber = stringValue(bill.RefNumber);
  await pool.query(
    `UPDATE vendor_bill
        SET qb_is_paid = $2,
            qb_balance_remaining_cents = $3,
            qb_payment_checked_at = NOW(),
            qb_edit_sequence = COALESCE($4, qb_edit_sequence),
            updated_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL`,
    [billId, paid, balanceCents, editSequence]
  );

  if (paid) {
    const message =
      "REBUILD BLOCKED: the Bill is paid in QuickBooks. Unapply the payment, then retry the preflight.";
    if (legacyId) {
      await pool.query(
        `UPDATE qb_vendor_bill_pipeline
            SET status = 'failed_permanent', qb_operation_id = NULL,
                last_error = $2, next_retry_at = NULL, updated_at = NOW()
          WHERE id = $1`,
        [legacyId, message]
      );
    }
    throw new PermanentPurchaseOperationError(message);
  }

  if (legacyId) {
    await pool.query(
      `UPDATE qb_vendor_bill_pipeline
          SET intent = 'rebuild_deleting', status = 'waiting',
              qb_operation_id = NULL, retries = 0,
              next_retry_at = NULL,
              edit_sequence = COALESCE($2, edit_sequence),
              last_error = 'QuickBooks confirmed the Bill is unpaid; waiting to delete',
              updated_at = NOW()
        WHERE id = $1`,
      [legacyId, editSequence]
    );
  }
  return {
    txnId: expectedTxnId,
    refNumber,
    editSequence,
  };
}

export async function completeVendorBillRebuildDelete(
  row: ResubmitRow,
  operation?: Record<string, unknown>
): Promise<VendorBillRebuildCompletion> {
  const billId = row.reference_id;
  if (!billId) {
    throw new PermanentPurchaseOperationError(
      "Vendor Bill rebuild delete is missing its local Bill ID"
    );
  }
  if (operation) {
    const messages = extractMessages(operation.result);
    const response = messages.TxnDelRs as
      | Record<string, unknown>
      | undefined;
    if (!response) {
      throw new Error(
        "Vendor Bill rebuild delete completed without TxnDelRs"
      );
    }
    const statusCode = String(
      response?.statusCode ?? response?.["@statusCode"] ?? "0"
    );
    if (statusCode !== "0" && statusCode !== "3120") {
      const message = String(
        response?.statusMessage ??
          response?.["@statusMessage"] ??
          `TxnDelRs statusCode=${statusCode}`
      );
      throw new Error(`QuickBooks Error ${statusCode}: ${message}`);
    }
  }

  const legacyId = stringValue(row.payload?.qb_vendor_bill_pipeline_id);
  const expectedTxnId =
    stringValue(row.qb_txn_id) ?? stringValue(row.payload?.txn_id);
  if (!legacyId || !expectedTxnId) {
    throw new PermanentPurchaseOperationError(
      "Vendor Bill rebuild delete is missing its pipeline identity or QB TxnID"
    );
  }
  const pool = getDbPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const billResult = await client.query(
      `SELECT qb_txn_id
         FROM vendor_bill
        WHERE id = $1 AND deleted_at IS NULL
        FOR UPDATE`,
      [billId]
    );
    const localBill = billResult.rows[0] as
      | { qb_txn_id: string | null }
      | undefined;
    if (!localBill) {
      throw new PermanentPurchaseOperationError(
        "Vendor Bill rebuild delete cannot find the local Bill"
      );
    }
    const pipelineResult = await client.query(
      `SELECT intent
         FROM qb_vendor_bill_pipeline
        WHERE id = $1 AND vendor_bill_id = $2 AND deleted_at IS NULL
        FOR UPDATE`,
      [legacyId, billId]
    );
    const pipeline = pipelineResult.rows[0] as
      | { intent: string }
      | undefined;
    if (!pipeline) {
      throw new PermanentPurchaseOperationError(
        "Vendor Bill rebuild delete cannot find its local pipeline row"
      );
    }
    if (pipeline.intent === "rebuild_ready" && localBill.qb_txn_id === null) {
      await client.query("COMMIT");
      return { txnId: null, refNumber: null, editSequence: null };
    }
    if (
      localBill.qb_txn_id !== null &&
      localBill.qb_txn_id !== expectedTxnId
    ) {
      throw new PermanentPurchaseOperationError(
        "Vendor Bill QB identity changed during rebuild; local cleanup was refused"
      );
    }
    await client.query(
      `UPDATE vendor_bill
          SET qb_txn_id = NULL,
              qb_edit_sequence = NULL,
              qb_ref_number = NULL,
              qb_synced_at = NULL,
              qb_clearing_lines = NULL,
              qb_is_paid = false,
              qb_balance_remaining_cents = NULL,
              status = 'draft',
              draft_revision_number = COALESCE(
                draft_revision_number,
                (
                  SELECT MAX(revision_number) + 1
                    FROM vendor_bill_revision
                   WHERE vendor_bill_id = $1
                ),
                2
              ),
              updated_at = NOW()
        WHERE id = $1 AND deleted_at IS NULL`,
      [billId]
    );
    await client.query(
      `UPDATE vendor_bill_line
          SET qb_txn_line_id = NULL, updated_at = NOW()
        WHERE vendor_bill_id = $1 AND deleted_at IS NULL`,
      [billId]
    );
    await client.query(
      `UPDATE qb_vendor_bill_pipeline
          SET intent = 'rebuild_ready', status = 'waiting',
              qb_operation_id = NULL, qb_txn_id = NULL,
              qb_ref_number = NULL, edit_sequence = NULL,
              rebuild_generation = rebuild_generation + 1,
              retries = 0, next_retry_at = NULL,
              last_error = 'QB Bill removed. Reconfirm this draft to create the rebuilt Bill.',
              updated_at = NOW()
        WHERE id = $1`,
      [legacyId]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return { txnId: null, refNumber: null, editSequence: null };
}

function vendorBillPaymentState(
  bill: Record<string, unknown>,
  amountDue: number | null
): "paid" | "unpaid" | "unknown" {
  const raw = bill.IsPaid;
  const paidFlag =
    raw === true || raw === "true" || raw === "1"
      ? true
      : raw === false || raw === "false" || raw === "0"
        ? false
        : null;
  if (paidFlag === true || (amountDue !== null && amountDue <= 0)) {
    return "paid";
  }
  if (paidFlag === false || (amountDue !== null && amountDue > 0)) {
    return "unpaid";
  }
  return "unknown";
}

function finiteNumber(value: unknown): number | null {
  if (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim().length === 0)
  ) {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function extractMessages(rawResult: unknown): Record<string, unknown> {
  const result = rawResult as Record<string, unknown> | null;
  const qbxml = result?.QBXML as Record<string, unknown> | undefined;
  return (
    (qbxml?.QBXMLMsgsRs as Record<string, unknown> | undefined) ??
    (result?.QBXMLMsgsRs as Record<string, unknown> | undefined) ??
    {}
  );
}

function toRecords(raw: unknown): Array<Record<string, unknown>> {
  if (raw == null) return [];
  return (Array.isArray(raw) ? raw : [raw]) as Array<
    Record<string, unknown>
  >;
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const result = String(value);
  return result.length > 0 ? result : null;
}
