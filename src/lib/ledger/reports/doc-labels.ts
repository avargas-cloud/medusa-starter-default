/**
 * Human labels and payee resolution for register rows. Labels are pure; the
 * payee is a SQL CASE over LEFT JOINs to the source documents, with E1's
 * `gl_check` joined only when the table (and a name column) exists — the
 * register must not 500 on a schema that has not received E1's migration.
 */
export interface SourceDocRef {
  kind: string;
  id: string;
}

const LABEL_PREFIX: Readonly<Record<string, string>> = {
  pos_invoice: "Invoice",
  pos_credit_memo: "Credit memo",
  vendor_bill: "Bill",
  vendor_bill_payment: "Bill payment",
  vendor_credit: "Vendor credit",
  journal_entry: "Journal",
  gl_journal_entry: "Journal",
  bank_check: "Check",
  check: "Check",
  gl_check: "Check",
  bank_transfer: "Transfer",
  transfer: "Transfer",
  gl_transfer: "Transfer",
  year_close: "Year close",
};

const LABEL_ONLY: Readonly<Record<string, string>> = {
  customer_payment: "Customer payment",
  po_receipt: "PO receipt",
  opening_balance: "Opening balance",
  rounding_adjustment: "Rounding adjustment",
};

/**
 * `qb_import` rows already carry a human `document_number` ("Check 1042",
 * "Deposit 1B4542-…"); everything else gets its family word in front. Kinds
 * whose document number is an opaque id ("cpay_…") show only the word.
 */
export function docLabelFor(
  sourceKind: string | null,
  documentNumber: string | null
): string {
  const kind = sourceKind ?? "";
  const doc = (documentNumber ?? "").trim();
  if (kind === "qb_import") return doc || "QB import";
  const only = LABEL_ONLY[kind];
  if (only) return only;
  const prefix = LABEL_PREFIX[kind];
  if (prefix) return doc ? `${prefix} ${doc}` : prefix;
  if (!kind) return doc || "Journal";
  const words = kind.replace(/_/g, " ");
  const humanKind = words.charAt(0).toUpperCase() + words.slice(1);
  return doc ? `${humanKind} ${doc}` : humanKind;
}

/** Candidate name columns on E1's `gl_check`, first match wins. */
export const GL_CHECK_PAYEE_COLUMNS = [
  "payee_name",
  "payee_name_snapshot",
  "payee",
  "vendor_name_snapshot",
] as const;

/**
 * LEFT JOINs from the entry alias `e` to every source document the payee can
 * come from. `pi`/`pcm`/`cp` resolve to `customer`; the purchasing family
 * carries `vendor_name_snapshot` on the document itself.
 */
export const PAYEE_JOIN_SQL = `
  LEFT JOIN pos_invoice pi ON e.source_kind = 'pos_invoice' AND pi.id = e.source_id
  LEFT JOIN pos_credit_memo pcm ON e.source_kind = 'pos_credit_memo' AND pcm.id = e.source_id
  LEFT JOIN customer_payment cp ON e.source_kind = 'customer_payment' AND cp.id = e.source_id
  LEFT JOIN customer cu ON cu.id = COALESCE(pi.customer_id, pcm.customer_id, cp.customer_id)
  LEFT JOIN vendor_bill vb ON e.source_kind = 'vendor_bill' AND vb.id = e.source_id
  LEFT JOIN vendor_bill_payment vbp ON e.source_kind = 'vendor_bill_payment' AND vbp.id = e.source_id
  LEFT JOIN vendor_credit vc ON e.source_kind = 'vendor_credit' AND vc.id = e.source_id
  LEFT JOIN purchase_order_receipt por ON e.source_kind = 'po_receipt' AND por.id = e.source_id
  LEFT JOIN purchase_order po ON po.id = por.purchase_order_id`;

export function glCheckJoinSql(payeeColumn: string | null): string {
  if (!payeeColumn) return "";
  return `
  LEFT JOIN gl_check gc ON e.source_kind IN ('bank_check', 'check', 'gl_check') AND gc.id = e.source_id`;
}

export function payeeColumnSql(glCheckPayeeColumn: string | null): string {
  const glCheck = glCheckPayeeColumn ? `gc."${glCheckPayeeColumn}",` : "";
  return `COALESCE(
    NULLIF(TRIM(cu.company_name), ''),
    NULLIF(TRIM(CONCAT_WS(' ', cu.first_name, cu.last_name)), ''),
    vb.vendor_name_snapshot, vbp.vendor_name_snapshot, vc.vendor_name_snapshot,
    po.vendor_name_snapshot,
    ${glCheck}
    CASE WHEN e.source_kind = 'qb_import' THEN NULLIF(e.source_snapshot->>'name', '') END
  )`;
}
