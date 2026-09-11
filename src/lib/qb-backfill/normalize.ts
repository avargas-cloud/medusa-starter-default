/**
 * src/lib/qb-backfill/normalize.ts
 *
 * `Ret` crudo del bridge (dict/array sin normalizar, montos en string
 * decimal) → formas tipadas de `types.ts` con montos en CENTS enteros.
 *
 * `moneyToCents` parte el string en parte entera/decimal ANTES de convertir
 * — nunca `parseFloat(x) * 100`, que introduce error de punto flotante
 * binario (ej. 0.1 + 0.2 !== 0.3) sobre valores de dinero reales.
 */
import { asList } from "./qb-client";
import type {
  QbBill,
  QbBillLine,
  QbBillPayment,
  QbBillPaymentApplication,
  QbItemReceipt,
  QbItemReceiptLine,
  QbLinkedTxn,
  QbPurchaseOrder,
  QbPurchaseOrderLine,
  QbRef,
  QbVendorCredit,
} from "./types";

type RawRef = { ListID?: string; FullName?: string } | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = Record<string, any>;

export function moneyToCents(raw: string | number | null | undefined): number {
  if (raw === null || raw === undefined || raw === "") return 0;
  const str = String(raw).trim();
  const neg = str.startsWith("-");
  const unsigned = neg ? str.slice(1) : str;
  const parts = unsigned.split(".");
  const intPartRaw = parts[0] ?? "";
  const decPartRaw = parts[1] ?? "";
  const intPart = intPartRaw === "" ? "0" : intPartRaw;
  const decPart = (decPartRaw + "00").slice(0, 2);
  if (!/^\d+$/.test(intPart) || !/^\d{2}$/.test(decPart)) {
    throw new Error(`monto QB no numérico: "${raw}"`);
  }
  const cents = parseInt(intPart, 10) * 100 + parseInt(decPart, 10);
  if (!Number.isSafeInteger(cents)) throw new Error(`monto QB fuera de rango seguro: "${raw}"`);
  return neg ? -cents : cents;
}

export function normalizeRef(ref: RawRef): QbRef | null {
  if (!ref || !ref.ListID) return null;
  return { list_id: ref.ListID, full_name: ref.FullName ?? "" };
}

export function normalizeLinkedTxns(raw: Raw): QbLinkedTxn[] {
  return asList<Raw>(raw?.LinkedTxn).map((l) => ({
    txn_id: l.TxnID,
    txn_type: l.TxnType,
    txn_date: l.TxnDate ?? null,
    amount_cents: l.Amount !== undefined ? moneyToCents(l.Amount) : null,
    ref_number: l.RefNumber ?? null,
  }));
}

function toBool(v: unknown): boolean {
  return v === true || v === "true";
}

function toNum(v: unknown): number {
  if (v === undefined || v === null || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ── Purchase Order ───────────────────────────────────────────────────────

function normalizePoLine(l: Raw): QbPurchaseOrderLine {
  return {
    txn_line_id: l.TxnLineID,
    item_ref: normalizeRef(l.ItemRef),
    manufacturer_part_number: l.ManufacturerPartNumber ?? null,
    description: l.Desc ?? null,
    quantity: toNum(l.Quantity),
    rate_cents: moneyToCents(l.Rate),
    amount_cents: moneyToCents(l.Amount),
    received_quantity: toNum(l.ReceivedQuantity),
    is_manually_closed: toBool(l.IsManuallyClosed),
  };
}

export function normalizePurchaseOrders(rs: Raw | null): QbPurchaseOrder[] {
  if (!rs) return [];
  return asList<Raw>(rs.PurchaseOrderRet).map((r) => ({
    txn_id: r.TxnID,
    edit_sequence: r.EditSequence,
    txn_number: r.TxnNumber ?? null,
    ref_number: r.RefNumber ?? null,
    vendor_ref: normalizeRef(r.VendorRef),
    txn_date: r.TxnDate,
    due_date: r.DueDate ?? null,
    expected_date: r.ExpectedDate ?? null,
    total_amount_cents: moneyToCents(r.TotalAmount),
    is_manually_closed: toBool(r.IsManuallyClosed),
    is_fully_received: toBool(r.IsFullyReceived),
    memo: r.Memo ?? null,
    lines: asList<Raw>(r.PurchaseOrderLineRet).map(normalizePoLine),
    linked_txns: normalizeLinkedTxns(r),
  }));
}

// ── Item Receipt ─────────────────────────────────────────────────────────

function normalizeReceiptLine(l: Raw): QbItemReceiptLine {
  const linkedPo = asList<Raw>(l.LinkedTxn).find((lt) => lt.TxnType === "PurchaseOrder");
  return {
    txn_line_id: l.TxnLineID,
    item_ref: normalizeRef(l.ItemRef),
    description: l.Desc ?? null,
    quantity: toNum(l.Quantity),
    rate_cents: moneyToCents(l.Cost ?? l.Rate),
    amount_cents: moneyToCents(l.Amount),
    linked_po_txn_id: linkedPo?.TxnID ?? null,
  };
}

export function normalizeItemReceipts(rs: Raw | null): QbItemReceipt[] {
  if (!rs) return [];
  return asList<Raw>(rs.ItemReceiptRet).map((r) => ({
    txn_id: r.TxnID,
    edit_sequence: r.EditSequence,
    ref_number: r.RefNumber ?? null,
    vendor_ref: normalizeRef(r.VendorRef),
    txn_date: r.TxnDate,
    total_amount_cents: moneyToCents(r.TotalAmount ?? r.Total),
    memo: r.Memo ?? null,
    lines: asList<Raw>(r.ItemLineRet).map(normalizeReceiptLine),
    linked_txns: normalizeLinkedTxns(r),
  }));
}

// ── Bill / Vendor Credit (comparten forma de línea) ─────────────────────

function normalizeItemLine(l: Raw): QbBillLine {
  return {
    txn_line_id: l.TxnLineID,
    item_ref: normalizeRef(l.ItemRef),
    account_ref: null,
    description: l.Desc ?? null,
    quantity: l.Quantity !== undefined ? toNum(l.Quantity) : null,
    rate_cents: l.Rate !== undefined ? moneyToCents(l.Rate) : null,
    amount_cents: moneyToCents(l.Amount),
  };
}

function normalizeExpenseLine(l: Raw): QbBillLine {
  return {
    txn_line_id: l.TxnLineID,
    item_ref: null,
    account_ref: normalizeRef(l.AccountRef),
    description: l.Memo ?? null,
    quantity: null,
    rate_cents: null,
    amount_cents: moneyToCents(l.Amount),
  };
}

export function normalizeBills(rs: Raw | null): QbBill[] {
  if (!rs) return [];
  return asList<Raw>(rs.BillRet).map((r) => ({
    txn_id: r.TxnID,
    edit_sequence: r.EditSequence,
    ref_number: r.RefNumber ?? null,
    vendor_ref: normalizeRef(r.VendorRef),
    ap_account_ref: normalizeRef(r.APAccountRef),
    txn_date: r.TxnDate,
    due_date: r.DueDate ?? null,
    amount_due_cents: moneyToCents(r.AmountDue),
    is_paid: toBool(r.IsPaid),
    memo: r.Memo ?? null,
    item_lines: asList<Raw>(r.ItemLineRet).map(normalizeItemLine),
    expense_lines: asList<Raw>(r.ExpenseLineRet).map(normalizeExpenseLine),
    linked_txns: normalizeLinkedTxns(r),
  }));
}

export function normalizeVendorCredits(rs: Raw | null): QbVendorCredit[] {
  if (!rs) return [];
  return asList<Raw>(rs.VendorCreditRet).map((r) => ({
    txn_id: r.TxnID,
    edit_sequence: r.EditSequence,
    ref_number: r.RefNumber ?? null,
    vendor_ref: normalizeRef(r.VendorRef),
    txn_date: r.TxnDate,
    amount_cents: moneyToCents(r.TotalAmount ?? r.Amount),
    memo: r.Memo ?? null,
    item_lines: asList<Raw>(r.ItemLineRet).map(normalizeItemLine),
    expense_lines: asList<Raw>(r.ExpenseLineRet).map(normalizeExpenseLine),
    linked_txns: normalizeLinkedTxns(r),
  }));
}

// ── Bill Payments (Check | CreditCard) ───────────────────────────────────

function normalizeApplication(a: Raw): QbBillPaymentApplication {
  return {
    txn_id: a.TxnID,
    txn_type: a.TxnType,
    txn_date: a.TxnDate ?? null,
    amount_cents: moneyToCents(a.Amount),
    balance_remaining_cents: a.BalanceRemaining !== undefined ? moneyToCents(a.BalanceRemaining) : null,
  };
}

export function normalizeBillPayments(
  rs: Raw | null,
  method: "check" | "credit_card"
): QbBillPayment[] {
  if (!rs) return [];
  const retKey = method === "check" ? "BillPaymentCheckRet" : "BillPaymentCreditCardRet";
  return asList<Raw>(rs[retKey]).map((r) => ({
    txn_id: r.TxnID,
    edit_sequence: r.EditSequence,
    payment_method: method,
    payee_ref: normalizeRef(r.PayeeEntityRef),
    ap_account_ref: normalizeRef(r.APAccountRef),
    bank_account_ref: normalizeRef(r.BankAccountRef),
    credit_card_account_ref: normalizeRef(r.CreditCardAccountRef),
    txn_date: r.TxnDate,
    amount_cents: moneyToCents(r.Amount),
    applications: asList<Raw>(r.AppliedToTxnRet).map(normalizeApplication),
  }));
}
