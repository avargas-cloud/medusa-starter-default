import { getDbPool } from "../../../api/utils/db-pool";
import { orderPurchaseOrderModLines } from "../purchase-order-line-order";
import { bridgeFetch, pollRawOperationResult } from "../client/core";
import type { ResubmitRow } from "./resubmit-by-step";
import {
  completeVendorBillRebuildDelete,
  completeVendorBillRebuildPreflight,
} from "./vendor-bill-rebuild-operations";

type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

interface QbRet {
  TxnID?: string;
  EditSequence?: string;
  RefNumber?: string;
  PurchaseOrderLineRet?: unknown;
}

interface DispatchResult {
  operationId: string;
  payload: Record<string, unknown>;
}

export interface CompletedPurchaseOperation {
  txnId: string | null;
  refNumber: string | null;
  editSequence: string | null;
}

export const PURCHASE_EXISTENCE_CHECK_KEY = "__purchase_add_existence_check";
const PURCHASE_EXISTENCE_VERIFIED_RETRY_KEY =
  "__purchase_add_verified_absent_retry";
/** Cuántas veces se re-armó el check para esta fila (tope anti-loop). */
const PURCHASE_EXISTENCE_ATTEMPTS_KEY = "__purchase_add_existence_attempts";
/**
 * Tope de re-armados automáticos. Si la propia consulta de existencia también
 * muere a nivel QBWC tres veces seguidas, el problema es del entorno de QB y no
 * de esta fila: seguir re-armando la dejaría girando invisible. Al agotarse,
 * cae al camino de falla normal y aparece en el feed para un humano.
 */
export const PURCHASE_EXISTENCE_MAX_ATTEMPTS = 3;

export const PURCHASE_OPERATION_STEPS = [
  "purchase_order_mod",
  "item_receipt_add",
  "item_receipt_mod",
  "vendor_bill_add",
  "vendor_bill_rebuild_preflight",
  "vendor_bill_rebuild_delete",
] as const;

export function isPurchaseOperationStep(step: string): boolean {
  return PURCHASE_OPERATION_STEPS.includes(
    step as (typeof PURCHASE_OPERATION_STEPS)[number]
  );
}

export async function dispatchPurchaseOperation(
  row: ResubmitRow,
  logger: Logger
): Promise<DispatchResult> {
  if (!row.payload) {
    throw new Error(`${row.step}: missing frozen payload`);
  }

  let payload = await refreshPoLineLinks(row.payload);
  if (row.step === "item_receipt_add") {
    payload = await refreshItemReceiptAddSnapshot(payload);
  }
  let method: "POST" | "PUT" | "DELETE";
  let path: string;
  let requestPayload = payload;
  let idempotencyKey: string | undefined;
  const isAdd =
    row.step === "item_receipt_add" || row.step === "vendor_bill_add";
  const verifiedRetry = Number(
    payload[PURCHASE_EXISTENCE_VERIFIED_RETRY_KEY] ?? -1
  );
  const retryCount = Number(row.retry_count ?? 0);
  const needsExistenceCheck =
    isAdd &&
    (payload[PURCHASE_EXISTENCE_CHECK_KEY] === true ||
      (retryCount > 0 && verifiedRetry !== retryCount));

  if (needsExistenceCheck) {
    payload = {
      ...payload,
      [PURCHASE_EXISTENCE_CHECK_KEY]: true,
    };
    method = "POST";
    if (row.step === "item_receipt_add") {
      path = "/api/item-receipts/query-by-ref";
      requestPayload = payload;
    } else {
      path = "/api/bills/query";
      requestPayload = {
        from_date: payload.txn_date,
        to_date: payload.txn_date,
        max_returned: 200,
      };
    }
  } else
    switch (row.step) {
      case "purchase_order_mod":
        payload = await refreshPurchaseOrderModSnapshot(payload, logger);
        method = "PUT";
        path = "/api/purchase-orders/mod";
        break;
      case "item_receipt_add":
        method = "POST";
        path = "/api/item-receipts";
        idempotencyKey = row.reference_id
          ? `item-receipt:${row.reference_id}`
          : undefined;
        break;
      case "item_receipt_mod":
        method = "POST";
        path = "/api/item-receipts/mod";
        break;
      case "vendor_bill_add": {
        method = "POST";
        path = "/api/bills";
        const generation = Number(payload.rebuild_generation ?? 0);
        idempotencyKey = row.reference_id
          ? `vendor-bill:${row.reference_id}:g${generation}`
          : undefined;
        break;
      }
      case "vendor_bill_rebuild_preflight": {
        const txnId = stringValue(payload.txn_id) ?? row.qb_txn_id;
        if (!txnId) {
          throw new Error(
            "vendor_bill_rebuild_preflight: missing QB TxnID"
          );
        }
        method = "POST";
        path = "/api/bills/query";
        requestPayload = { txn_id: txnId, max_returned: 5 };
        break;
      }
      case "vendor_bill_rebuild_delete": {
        const txnId = stringValue(payload.txn_id) ?? row.qb_txn_id;
        if (!txnId) {
          throw new Error("vendor_bill_rebuild_delete: missing QB TxnID");
        }
        method = "DELETE";
        path = `/api/bills/${encodeURIComponent(txnId)}`;
        requestPayload = {};
        break;
      }
      default:
        throw new Error(`Unsupported purchase operation step '${row.step}'`);
    }

  const response = await bridgeFetch(method, path, requestPayload, {
    idempotencyKey,
  });
  if (!response?.operationId) {
    throw new Error(
      response?.error ?? `${row.step}: bridge returned no operationId`
    );
  }

  const pool = getDbPool();
  await pool.query(
    `UPDATE qb_order_pipeline
        SET payload = $2::jsonb,
            status = 'submitted',
            bridge_op_id = $3,
            submitted_at = NOW(),
            updated_at = NOW()
      WHERE id = $1`,
    [row.id, JSON.stringify(payload), response.operationId]
  );
  await mirrorSubmittedToLegacy(row, response.operationId);

  return { operationId: response.operationId, payload };
}

export async function refreshVendorBillModSnapshot(
  payload: Record<string, unknown>,
  logger: Logger
): Promise<Record<string, unknown>> {
  const txnId = stringValue(payload.txn_id);
  if (!txnId) throw new Error("vendor_bill_mod: missing txn_id");

  const query = await bridgeFetch("POST", "/api/bills/query", {
    txn_id: txnId,
    max_returned: 1,
  });
  if (!query?.operationId) {
    throw new Error("vendor_bill_mod: BillQuery returned no operationId");
  }
  const raw = await pollRawOperationResult(query.operationId, (message) =>
    logger.info(`[QB-PURCHASE-CHAIN] ${message}`)
  );
  const msgs = extractMessages(
    (raw as Record<string, unknown> | null)?.result ?? raw
  );
  const candidates = toRecords(
    (msgs.BillQueryRs as Record<string, unknown> | undefined)?.BillRet
  );
  const bill =
    candidates.find((candidate) => stringValue(candidate.TxnID) === txnId) ??
    null;
  const editSequence = stringValue(bill?.EditSequence);
  if (!bill || !editSequence) {
    throw new Error(
      "vendor_bill_mod: QuickBooks query returned no exact Bill/EditSequence match"
    );
  }
  return {
    ...payload,
    edit_sequence: editSequence,
  };
}

export async function completePurchaseAddExistenceCheck(
  row: ResubmitRow,
  operation: Record<string, unknown>
): Promise<CompletedPurchaseOperation | null> {
  if (row.step !== "item_receipt_add" && row.step !== "vendor_bill_add") {
    throw new Error(`Existence checks are not supported for '${row.step}'`);
  }
  const msgs = extractMessages(operation.result);
  const rawCandidates =
    row.step === "item_receipt_add"
      ? (msgs.ItemReceiptQueryRs as Record<string, unknown> | undefined)
          ?.ItemReceiptRet
      : (msgs.BillQueryRs as Record<string, unknown> | undefined)?.BillRet;
  const candidates = toRecords(rawCandidates);
  const matched =
    row.step === "item_receipt_add"
      ? matchExistingItemReceipt(candidates, row.payload ?? {})
      : matchExistingVendorBill(candidates, row.payload ?? {});
  if (!matched) {
    await markPurchaseAddVerifiedAbsent(row);
    return null;
  }

  const txnId = stringValue(matched.TxnID);
  if (!txnId) {
    throw new Error(
      `${row.step}: existence query matched a transaction without TxnID`
    );
  }
  const refNumber = stringValue(matched.RefNumber);
  const editSequence = stringValue(matched.EditSequence);
  if (row.step === "item_receipt_add") {
    await completeItemReceiptAdd(row, txnId, refNumber, editSequence);
  } else {
    await completeVendorBillAdd(row, matched, txnId, refNumber, editSequence);
  }
  return { txnId, refNumber, editSequence };
}

/**
 * Devuelve `true` si la fila quedó armada para verificar existencia contra
 * QuickBooks antes de cualquier ADD; `false` si el llamador debe seguir por el
 * camino de falla normal (paso no soportado o tope de intentos agotado).
 *
 * El `false` es la parte importante del contrato: quien llama NO puede asumir
 * que la fila quedó atendida — si asume, un ADD que agotó el tope se queda en
 * 'submitted' para siempre, sin operación de bridge que lo destrabe.
 */
export async function schedulePurchaseAddExistenceCheck(
  row: ResubmitRow,
  reason: string
): Promise<boolean> {
  if (row.step !== "item_receipt_add" && row.step !== "vendor_bill_add") {
    return false;
  }
  const attempts = Number(row.payload?.[PURCHASE_EXISTENCE_ATTEMPTS_KEY] ?? 0);
  if (Number.isFinite(attempts) && attempts >= PURCHASE_EXISTENCE_MAX_ATTEMPTS) {
    return false;
  }
  const pool = getDbPool();
  const { rowCount } = await pool.query(
    `UPDATE qb_order_pipeline
        SET status = 'pending',
            payload = COALESCE(payload, '{}'::jsonb) ||
              jsonb_build_object($2::text, true) ||
              jsonb_build_object($4::text, $5::int),
            bridge_op_id = NULL,
            submitted_at = NULL,
            next_retry_at = NOW(),
            error = $3,
            updated_at = NOW()
      WHERE id = $1 AND status = 'submitted'`,
    [
      row.id,
      PURCHASE_EXISTENCE_CHECK_KEY,
      reason,
      PURCHASE_EXISTENCE_ATTEMPTS_KEY,
      (Number.isFinite(attempts) ? attempts : 0) + 1,
    ]
  );
  // La fila dejó de estar 'submitted' entre el poll y este UPDATE (otra pasada
  // la movió). No se re-armó nada: que el llamador decida, no que lo suponga.
  if (rowCount !== 1) return false;
  await mirrorPurchaseAddWaiting(row, reason);
  return true;
}

async function markPurchaseAddVerifiedAbsent(row: ResubmitRow): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `UPDATE qb_order_pipeline
        SET status = 'pending',
            payload =
              (COALESCE(payload, '{}'::jsonb) - $2::text) ||
              jsonb_build_object($3::text, retry_count),
            bridge_op_id = NULL,
            submitted_at = NULL,
            next_retry_at = NULL,
            error = 'Verified absent in QuickBooks; safe to submit Add',
            updated_at = NOW()
      WHERE id = $1`,
    [
      row.id,
      PURCHASE_EXISTENCE_CHECK_KEY,
      PURCHASE_EXISTENCE_VERIFIED_RETRY_KEY,
    ]
  );
  await mirrorPurchaseAddWaiting(
    row,
    "Verified absent in QuickBooks; safe to submit Add"
  );
}

async function mirrorPurchaseAddWaiting(
  row: ResubmitRow,
  reason: string
): Promise<void> {
  const pool = getDbPool();
  const legacyId =
    typeof row.payload?.qb_item_receipt_pipeline_id === "string"
      ? row.payload.qb_item_receipt_pipeline_id
      : typeof row.payload?.qb_vendor_bill_pipeline_id === "string"
        ? row.payload.qb_vendor_bill_pipeline_id
        : null;
  if (!legacyId) return;
  if (row.step === "item_receipt_add") {
    await pool.query(
      `UPDATE qb_item_receipt_pipeline
          SET status = 'waiting', qb_operation_id = NULL,
              last_error = $2, updated_at = NOW()
        WHERE id = $1`,
      [legacyId, reason]
    );
  } else if (row.step === "vendor_bill_add") {
    await pool.query(
      `UPDATE qb_vendor_bill_pipeline
          SET status = 'waiting', qb_operation_id = NULL,
              last_error = $2, updated_at = NOW()
        WHERE id = $1`,
      [legacyId, reason]
    );
  }
}

function matchExistingItemReceipt(
  candidates: Array<Record<string, unknown>>,
  payload: Record<string, unknown>
): Record<string, unknown> | null {
  const expectedRef = stringValue(
    payload.vendor_bill_number ?? payload.receipt_number
  );
  const expectedVendor = stringValue(payload.vendor_qb_list_id);
  const expectedIdentityMemo = stringValue(payload.qb_identity_memo);
  return (
    candidates.find((candidate) => {
      const vendor = candidate.VendorRef as Record<string, unknown> | undefined;
      const sameRef =
        !expectedRef || stringValue(candidate.RefNumber) === expectedRef;
      const sameVendor =
        !expectedVendor || stringValue(vendor?.ListID) === expectedVendor;
      const sameIdentity =
        !expectedIdentityMemo ||
        stringValue(candidate.Memo) === expectedIdentityMemo;
      return sameRef && sameVendor && sameIdentity;
    }) ?? null
  );
}

function matchExistingVendorBill(
  candidates: Array<Record<string, unknown>>,
  payload: Record<string, unknown>
): Record<string, unknown> | null {
  const expectedVendor = stringValue(payload.vendor_qb_list_id);
  const expectedMemo = stringValue(payload.memo);
  const expectedRef = stringValue(payload.ref_number);
  return (
    candidates.find((candidate) => {
      const vendor = candidate.VendorRef as Record<string, unknown> | undefined;
      const sameVendor =
        !expectedVendor || stringValue(vendor?.ListID) === expectedVendor;
      if (!sameVendor) return false;
      return (
        (expectedMemo && stringValue(candidate.Memo) === expectedMemo) ||
        (expectedRef && stringValue(candidate.RefNumber) === expectedRef)
      );
    }) ?? null
  );
}

async function refreshPoLineLinks(
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const linesKey = Array.isArray(payload.lines)
    ? "lines"
    : Array.isArray(payload.item_lines)
      ? "item_lines"
      : null;
  if (!linesKey) return payload;

  const lines = payload[linesKey] as Array<Record<string, unknown>>;
  const ids = lines
    .map((line) => line.po_line_id ?? line.purchase_order_line_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (ids.length === 0) return payload;

  const pool = getDbPool();
  const result = await pool.query(
    `SELECT id, qb_txn_line_id
       FROM purchase_order_line
      WHERE id = ANY($1::text[]) AND deleted_at IS NULL`,
    [ids]
  );
  const byId = new Map(
    result.rows.map((line) => [
      String(line.id),
      line.qb_txn_line_id ? String(line.qb_txn_line_id) : null,
    ])
  );

  return {
    ...payload,
    [linesKey]: lines.map((line) => {
      const poLineId = line.po_line_id ?? line.purchase_order_line_id;
      if (typeof poLineId !== "string") return line;
      const fresh = byId.get(poLineId);
      return fresh
        ? {
            ...line,
            qb_po_txn_line_id: fresh,
          }
        : line;
    }),
  };
}

async function refreshItemReceiptAddSnapshot(
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (!Array.isArray(payload.lines)) return payload;
  const lines = payload.lines as Array<Record<string, unknown>>;
  const lineIds = lines
    .map((line) => line.receipt_line_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (lineIds.length === 0) return payload;

  const pool = getDbPool();
  const result = await pool.query(
    `SELECT rl.id, rl.qty_received_now,
            COALESCE(rl.unit_cost_cents_override, pol.unit_cost_cents)
              AS unit_cost_cents
       FROM purchase_order_receipt_line rl
       JOIN purchase_order_line pol ON pol.id = rl.purchase_order_line_id
      WHERE rl.id = ANY($1::text[])
        AND rl.deleted_at IS NULL
        AND rl.qty_received_now > 0`,
    [lineIds]
  );
  const live = new Map(
    result.rows.map((line) => [
      String(line.id),
      {
        quantity: Number(line.qty_received_now),
        unitCostCents: Number(line.unit_cost_cents),
      },
    ])
  );
  const refreshed = lines.flatMap((line) => {
    const lineId = stringValue(line.receipt_line_id);
    const current = lineId ? live.get(lineId) : null;
    if (!current) return [];
    return [
      {
        ...line,
        qty_received_now: current.quantity,
        unit_cost_cents: current.unitCostCents,
      },
    ];
  });
  if (refreshed.length === 0) {
    throw new Error(
      "item_receipt_add: all receipt lines were removed before QuickBooks dispatch"
    );
  }
  return { ...payload, lines: refreshed };
}

async function refreshPurchaseOrderModSnapshot(
  payload: Record<string, unknown>,
  logger: Logger
): Promise<Record<string, unknown>> {
  const txnId = typeof payload.txn_id === "string" ? payload.txn_id : null;
  if (!txnId) throw new Error("purchase_order_mod: missing txn_id");

  const query = await bridgeFetch("POST", "/api/purchase-orders/query", {
    txn_id: txnId,
    po_id: payload.po_id,
  });
  if (!query?.operationId) {
    throw new Error("purchase_order_mod: query returned no operationId");
  }
  const raw = await pollRawOperationResult(query.operationId, (message) =>
    logger.info(`[QB-PURCHASE-CHAIN] ${message}`)
  );
  const ret = extractPurchaseOrderRet(raw);
  if (!ret?.EditSequence) {
    throw new Error(
      "purchase_order_mod: QuickBooks query returned no EditSequence"
    );
  }

  const liveLines = normalizeRetLines(ret.PurchaseOrderLineRet);
  const bySku = new Map<string, string[]>();
  for (const line of liveLines) {
    const queue = bySku.get(line.sku) ?? [];
    queue.push(line.txnLineId);
    bySku.set(line.sku, queue);
  }
  const payloadLines = Array.isArray(payload.lines)
    ? (payload.lines as Array<Record<string, unknown>>)
    : [];
  const refreshedLines = orderPurchaseOrderModLines(payloadLines).map(
    (line) => {
      const sku = String(line.sku ?? "");
      const queue = bySku.get(sku) ?? [];
      const txnLineId = queue.shift() ?? line.qb_txn_line_id ?? null;
      return { ...line, qb_txn_line_id: txnLineId };
    }
  );

  return {
    ...payload,
    edit_sequence: String(ret.EditSequence),
    lines: refreshedLines,
  };
}

function extractPurchaseOrderRet(raw: unknown): QbRet | null {
  const result = raw as Record<string, unknown> | null;
  const qbxml = result?.QBXML as Record<string, unknown> | undefined;
  const msgs =
    (qbxml?.QBXMLMsgsRs as Record<string, unknown> | undefined) ??
    (result?.QBXMLMsgsRs as Record<string, unknown> | undefined) ??
    {};
  const response = msgs.PurchaseOrderQueryRs as
    | Record<string, unknown>
    | undefined;
  const ret = response?.PurchaseOrderRet;
  const resolved = Array.isArray(ret) ? ret[0] : ret;
  return (resolved as QbRet | undefined) ?? null;
}

function normalizeRetLines(
  raw: unknown
): Array<{ sku: string; txnLineId: string }> {
  const lines = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
  return lines
    .map((line) => {
      const row = line as Record<string, unknown>;
      const itemRef = row.ItemRef as Record<string, unknown> | undefined;
      return {
        sku: String(itemRef?.FullName ?? ""),
        txnLineId: String(row.TxnLineID ?? ""),
      };
    })
    .filter((line) => line.sku.length > 0 && line.txnLineId.length > 0);
}

async function mirrorSubmittedToLegacy(
  row: ResubmitRow,
  operationId: string
): Promise<void> {
  const pool = getDbPool();
  const legacyId =
    typeof row.payload?.qb_purchase_order_pipeline_id === "string"
      ? row.payload.qb_purchase_order_pipeline_id
      : typeof row.payload?.qb_item_receipt_pipeline_id === "string"
        ? row.payload.qb_item_receipt_pipeline_id
        : typeof row.payload?.qb_vendor_bill_pipeline_id === "string"
          ? row.payload.qb_vendor_bill_pipeline_id
          : null;
  if (!legacyId) return;

  if (row.step === "purchase_order_mod") {
    await pool.query(
      `UPDATE qb_purchase_order_pipeline
          SET status = 'submitted', qb_operation_id = $2,
              updated_at = NOW()
        WHERE id = $1`,
      [legacyId, operationId]
    );
  } else if (row.step === "item_receipt_add") {
    await pool.query(
      `UPDATE qb_item_receipt_pipeline
          SET qb_operation_id = $2, updated_at = NOW()
        WHERE id = $1`,
      [legacyId, operationId]
    );
  } else if (row.step === "item_receipt_mod") {
    await pool.query(
      `UPDATE qb_item_receipt_pipeline
          SET mod_status = 'submitted', mod_operation_id = $2, updated_at = NOW()
        WHERE id = $1`,
      [legacyId, operationId]
    );
  } else if (row.step === "vendor_bill_add") {
    await pool.query(
      `UPDATE qb_vendor_bill_pipeline
          SET status = 'submitted', qb_operation_id = $2, updated_at = NOW()
        WHERE id = $1`,
      [legacyId, operationId]
    );
  } else if (
    row.step === "vendor_bill_rebuild_preflight" ||
    row.step === "vendor_bill_rebuild_delete"
  ) {
    await pool.query(
      `UPDATE qb_vendor_bill_pipeline
          SET status = 'submitted', qb_operation_id = $2,
              last_error = NULL, next_retry_at = NULL, updated_at = NOW()
        WHERE id = $1`,
      [legacyId, operationId]
    );
  }
}

export async function mirrorPurchaseOperationFailure(
  row: ResubmitRow,
  error: string,
  permanent = false
): Promise<void> {
  const pool = getDbPool();
  const legacyId =
    typeof row.payload?.qb_purchase_order_pipeline_id === "string"
      ? row.payload.qb_purchase_order_pipeline_id
      : typeof row.payload?.qb_item_receipt_pipeline_id === "string"
        ? row.payload.qb_item_receipt_pipeline_id
        : typeof row.payload?.qb_vendor_bill_pipeline_id === "string"
          ? row.payload.qb_vendor_bill_pipeline_id
          : null;
  if (!legacyId) return;

  if (row.step === "purchase_order_mod") {
    await pool.query(
      `UPDATE qb_purchase_order_pipeline
          SET status = 'error', qb_operation_id = NULL,
              last_error = $2, next_retry_at = NOW() + INTERVAL '2 minutes',
              updated_at = NOW()
        WHERE id = $1`,
      [legacyId, error]
    );
  } else if (row.step === "item_receipt_add") {
    await pool.query(
      `UPDATE qb_item_receipt_pipeline
          SET status = 'error', qb_operation_id = NULL,
              last_error = $2, next_retry_at = NOW() + INTERVAL '2 minutes',
              updated_at = NOW()
        WHERE id = $1`,
      [legacyId, error]
    );
  } else if (row.step === "item_receipt_mod") {
    await pool.query(
      `UPDATE qb_item_receipt_pipeline
          SET mod_status = 'error', mod_operation_id = NULL,
              mod_last_error = $2,
              mod_next_retry_at = NOW() + INTERVAL '2 minutes',
              updated_at = NOW()
        WHERE id = $1`,
      [legacyId, error]
    );
  } else if (row.step === "vendor_bill_add") {
    await pool.query(
      `UPDATE qb_vendor_bill_pipeline
          SET status = 'error', qb_operation_id = NULL,
              last_error = $2, next_retry_at = NOW() + INTERVAL '2 minutes',
              updated_at = NOW()
        WHERE id = $1`,
      [legacyId, error]
    );
  } else if (
    row.step === "vendor_bill_rebuild_preflight" ||
    row.step === "vendor_bill_rebuild_delete"
  ) {
    await pool.query(
      `UPDATE qb_vendor_bill_pipeline
          SET status = $2, qb_operation_id = NULL,
              last_error = $3,
              next_retry_at = CASE
                WHEN $2 = 'failed_permanent' THEN NULL
                ELSE NOW() + INTERVAL '2 minutes'
              END,
              updated_at = NOW()
        WHERE id = $1`,
      [legacyId, permanent ? "failed_permanent" : "error", error]
    );
  }
}

export async function completePurchaseOperation(
  row: ResubmitRow,
  operation: Record<string, unknown>
): Promise<CompletedPurchaseOperation> {
  if (!isPurchaseOperationStep(row.step)) {
    throw new Error(`Unsupported completed purchase step '${row.step}'`);
  }
  if (row.step === "vendor_bill_rebuild_preflight") {
    return completeVendorBillRebuildPreflight(row, operation);
  }
  if (row.step === "vendor_bill_rebuild_delete") {
    return completeVendorBillRebuildDelete(row, operation);
  }
  const msgs = extractMessages(operation.result);
  const responseKey =
    row.step === "purchase_order_mod"
      ? "PurchaseOrderModRs"
      : row.step === "item_receipt_add"
        ? "ItemReceiptAddRs"
        : row.step === "item_receipt_mod"
          ? "ItemReceiptModRs"
          : "BillAddRs";
  const response = msgs[responseKey] as Record<string, unknown> | undefined;
  const statusCode = String(
    response?.statusCode ?? response?.["@statusCode"] ?? "0"
  );
  if (statusCode !== "0") {
    const message = String(
      response?.statusMessage ??
        response?.["@statusMessage"] ??
        `${responseKey} statusCode=${statusCode}`
    );
    throw new Error(`QuickBooks Error ${statusCode}: ${message}`);
  }

  const retKey =
    row.step === "purchase_order_mod"
      ? "PurchaseOrderRet"
      : row.step === "item_receipt_add" || row.step === "item_receipt_mod"
        ? "ItemReceiptRet"
        : "BillRet";
  const rawRet = response?.[retKey];
  const ret = (Array.isArray(rawRet) ? rawRet[0] : rawRet) as
    | Record<string, unknown>
    | undefined;
  if (!ret) {
    throw new Error(`${row.step}: completed without ${retKey}`);
  }

  const txnId = stringValue(operation.txnId ?? ret.TxnID ?? row.qb_txn_id);
  const refNumber = stringValue(operation.refNumber ?? ret.RefNumber);
  const editSequence = stringValue(operation.editSequence ?? ret.EditSequence);
  if (!txnId) {
    throw new Error(`${row.step}: completed without TxnID`);
  }

  if (row.step === "purchase_order_mod") {
    await completePurchaseOrder(row, ret, txnId, refNumber, editSequence);
  } else if (row.step === "item_receipt_add") {
    await completeItemReceiptAdd(row, txnId, refNumber, editSequence);
  } else if (row.step === "item_receipt_mod") {
    await completeItemReceiptMod(row, editSequence);
  } else {
    await completeVendorBillAdd(row, ret, txnId, refNumber, editSequence);
  }

  return { txnId, refNumber, editSequence };
}

async function completePurchaseOrder(
  row: ResubmitRow,
  ret: Record<string, unknown>,
  txnId: string,
  refNumber: string | null,
  editSequence: string | null
): Promise<void> {
  const pool = getDbPool();
  const poId = row.order_id;
  if (!poId) throw new Error("purchase_order_mod: missing purchase order id");
  await pool.query(
    `UPDATE purchase_order
        SET qb_purchase_order_list_id = $2,
            qb_purchase_order_txn_number =
              COALESCE($3, qb_purchase_order_txn_number),
            qb_edit_sequence = COALESCE($4, qb_edit_sequence),
            qb_synced_at = NOW(),
            updated_at = NOW()
      WHERE id = $1`,
    [poId, txnId, refNumber, editSequence]
  );

  const payloadLines = Array.isArray(row.payload?.lines)
    ? (row.payload?.lines as Array<Record<string, unknown>>)
    : [];
  const retLines = normalizePoRetRows(ret.PurchaseOrderLineRet);
  const bySku = new Map<string, string[]>();
  for (const retLine of retLines) {
    const queue = bySku.get(retLine.sku) ?? [];
    queue.push(retLine.txnLineId);
    bySku.set(retLine.sku, queue);
  }
  for (const line of payloadLines) {
    const lineId = stringValue(line.line_id);
    if (!lineId) continue;
    const sku = stringValue(line.sku) ?? "";
    const queue = bySku.get(sku) ?? [];
    const txnLineId = queue.shift();
    if (!txnLineId) continue;
    await pool.query(
      `UPDATE purchase_order_line
          SET qb_txn_line_id = $2, updated_at = NOW()
        WHERE id = $1`,
      [lineId, txnLineId]
    );
  }

  const legacyId = stringValue(row.payload?.qb_purchase_order_pipeline_id);
  if (legacyId) {
    await pool.query(
      `UPDATE qb_purchase_order_pipeline
          SET status = 'synced', qb_operation_id = NULL,
              qb_list_id = $2,
              qb_txn_number = COALESCE($3, qb_txn_number),
              last_error = NULL, next_retry_at = NULL,
              synced_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [legacyId, txnId, refNumber]
    );
  }
}

async function completeItemReceiptAdd(
  row: ResubmitRow,
  txnId: string,
  refNumber: string | null,
  editSequence: string | null
): Promise<void> {
  const pool = getDbPool();
  const receiptId = row.reference_id;
  if (!receiptId) throw new Error("item_receipt_add: missing receipt id");
  await pool.query(
    `UPDATE purchase_order_receipt
        SET qb_item_receipt_list_id = $2,
            qb_item_receipt_txn_number =
              COALESCE($3, qb_item_receipt_txn_number),
            qb_edit_sequence = COALESCE($4, qb_edit_sequence),
            qb_synced_at = NOW(),
            status = CASE WHEN status = 'pending' THEN 'applied' ELSE status END,
            updated_at = NOW()
      WHERE id = $1`,
    [receiptId, txnId, refNumber, editSequence]
  );
  const legacyId = stringValue(row.payload?.qb_item_receipt_pipeline_id);
  if (legacyId) {
    await pool.query(
      `UPDATE qb_item_receipt_pipeline
          SET status = 'synced', qb_operation_id = NULL,
              qb_list_id = $2,
              qb_txn_number = COALESCE($3, qb_txn_number),
              last_error = NULL, next_retry_at = NULL,
              synced_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [legacyId, txnId, refNumber]
    );
  }
}

async function completeItemReceiptMod(
  row: ResubmitRow,
  editSequence: string | null
): Promise<void> {
  const pool = getDbPool();
  const receiptId = row.reference_id;
  if (!receiptId) throw new Error("item_receipt_mod: missing receipt id");
  if (editSequence) {
    await pool.query(
      `UPDATE purchase_order_receipt
          SET qb_edit_sequence = $2, updated_at = NOW()
        WHERE id = $1`,
      [receiptId, editSequence]
    );
  }
  const legacyId = stringValue(row.payload?.qb_item_receipt_pipeline_id);
  if (legacyId) {
    await pool.query(
      `UPDATE qb_item_receipt_pipeline
          SET mod_status = 'completed', mod_operation_id = NULL,
              mod_synced_at = NOW(), mod_payload = NULL,
              mod_last_error = NULL, mod_next_retry_at = NULL,
              updated_at = NOW()
        WHERE id = $1`,
      [legacyId]
    );
  }
}

async function completeVendorBillAdd(
  row: ResubmitRow,
  ret: Record<string, unknown>,
  txnId: string,
  refNumber: string | null,
  editSequence: string | null
): Promise<void> {
  const pool = getDbPool();
  const billId = row.reference_id;
  if (!billId) throw new Error("vendor_bill_add: missing bill id");
  const itemLines = Array.isArray(row.payload?.item_lines)
    ? (row.payload?.item_lines as Array<Record<string, unknown>>)
    : [];
  const expenseLines = Array.isArray(row.payload?.expense_lines)
    ? (row.payload?.expense_lines as Array<Record<string, unknown>>)
    : [];
  const itemRets = toRecords(ret.ItemLineRet);
  const expenseRets = toRecords(ret.ExpenseLineRet);

  const sortedItems = [...itemLines].sort((left, right) =>
    compareLineIds(left.qb_po_txn_line_id, right.qb_po_txn_line_id)
  );
  const missingItemIdentity = sortedItems.findIndex(
    (_line, index) => !stringValue(itemRets[index]?.TxnLineID)
  );
  const missingExpenseIdentity = expenseLines.findIndex(
    (_line, index) => !stringValue(expenseRets[index]?.TxnLineID)
  );
  if (missingItemIdentity >= 0 || missingExpenseIdentity >= 0) {
    throw new Error(
      "vendor_bill_add: QuickBooks returned fewer line identities than the submitted Bill"
    );
  }
  for (let index = 0; index < sortedItems.length; index++) {
    const lineId = stringValue(sortedItems[index]?.vendor_bill_line_id);
    const txnLineId = stringValue(itemRets[index]?.TxnLineID);
    if (!lineId || !txnLineId) continue;
    await pool.query(
      `UPDATE vendor_bill_line
          SET qb_txn_line_id = $2, updated_at = NOW()
        WHERE id = $1`,
      [lineId, txnLineId]
    );
  }
  for (let index = 0; index < expenseLines.length; index++) {
    const lineId = stringValue(expenseLines[index]?.vendor_bill_line_id);
    const txnLineId = stringValue(expenseRets[index]?.TxnLineID);
    if (!lineId || !txnLineId) continue;
    await pool.query(
      `UPDATE vendor_bill_line
          SET qb_txn_line_id = $2, updated_at = NOW()
        WHERE id = $1`,
      [lineId, txnLineId]
    );
  }

  await pool.query(
    `UPDATE vendor_bill
        SET qb_txn_id = $2,
            qb_edit_sequence = COALESCE($3, qb_edit_sequence),
            qb_ref_number = COALESCE($4, qb_ref_number),
            qb_synced_at = NOW(), qb_source = 'owned',
            status = 'synced', updated_at = NOW()
      WHERE id = $1`,
    [billId, txnId, editSequence, refNumber]
  );
  const legacyId = stringValue(row.payload?.qb_vendor_bill_pipeline_id);
  if (legacyId) {
    await pool.query(
      `UPDATE qb_vendor_bill_pipeline
          SET status = 'synced', qb_operation_id = NULL,
              qb_txn_id = $2,
              qb_ref_number = COALESCE($3, qb_ref_number),
              edit_sequence = COALESCE($4, edit_sequence),
              synced_at = NOW(), retries = 0,
              last_error = NULL, next_retry_at = NULL,
              updated_at = NOW()
        WHERE id = $1`,
      [legacyId, txnId, refNumber, editSequence]
    );
  }
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

function normalizePoRetRows(
  raw: unknown
): Array<{ sku: string; txnLineId: string }> {
  return toRecords(raw)
    .map((line) => {
      const itemRef = line.ItemRef as Record<string, unknown> | undefined;
      return {
        sku: stringValue(itemRef?.FullName) ?? "",
        txnLineId: stringValue(line.TxnLineID) ?? "",
      };
    })
    .filter((line) => line.sku.length > 0 && line.txnLineId.length > 0);
}

function toRecords(raw: unknown): Array<Record<string, unknown>> {
  if (raw == null) return [];
  return (Array.isArray(raw) ? raw : [raw]) as Array<Record<string, unknown>>;
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const result = String(value);
  return result.length > 0 ? result : null;
}

function compareLineIds(left: unknown, right: unknown): number {
  const leftValue = Number(left);
  const rightValue = Number(right);
  if (Number.isFinite(leftValue) && Number.isFinite(rightValue)) {
    return leftValue - rightValue;
  }
  return String(left ?? "").localeCompare(String(right ?? ""));
}
