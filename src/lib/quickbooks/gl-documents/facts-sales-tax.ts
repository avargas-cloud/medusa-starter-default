import { toQbRefNumber } from "../qb-ref-number";
import {
  one,
  resolveAccounts,
  structural,
  transient,
  type GlDocumentAddFacts,
  type GlDocumentDb,
} from "./facts-shared";
import {
  buildJournalEntryAddQbxml,
  buildSalesTaxPaymentCheckAddQbxml,
  type JournalLineInput,
  type SalesTaxPaymentLineInput,
} from "./qbxml-builders";

/**
 * facts de los documentos de sales tax (sales-tax-center-20260917) — mismo
 * contrato que `facts.ts`: se llama al encolar y al despachar, y decide
 * ready / estructural / transitorio.
 *
 * Adjust Sales Tax Due → JournalEntryAdd con `EntityRef` = vendor del DOR en la
 * línea del payable (QuickBooks lo exige para que la ventana Pay Sales Tax lo
 * vea como ajuste). Sin vendor ListID es estructural: un ajuste sin entidad
 * sería un JE suelto que Pay Sales Tax nunca aplica.
 *
 * Pay Sales Tax → SalesTaxPaymentCheckAdd: línea 1 = ItemSalesTax por el bruto;
 * una línea SIN item por cada STA aplicado (negativa si baja la deuda). Los STA
 * aplicados tienen que estar YA en QuickBooks (su JE confirmado): si falta el
 * TxnID es transitorio — el despachador difiere y vuelve a preguntar, igual que
 * un depósito espera el TxnID de sus cobros.
 */

interface AdjustmentRow {
  id: string;
  doc_number: string;
  period: string;
  day: string;
  type: string;
  direction: "decrease" | "increase";
  amount_cents: string;
  payable_list_id: string;
  offset_account_list_id: string;
  vendor_list_id: string | null;
  memo: string | null;
  reason: string | null;
  status: string;
  qb_txn_id: string | null;
}

export async function salesTaxAdjustmentFacts(db: GlDocumentDb, id: string): Promise<GlDocumentAddFacts> {
  const doc = one<AdjustmentRow>(
    await db.raw(
      `SELECT id, doc_number, period, day::text AS day, type, direction, amount_cents::text AS amount_cents,
              payable_list_id, offset_account_list_id, vendor_list_id, memo, reason, status, qb_txn_id
         FROM gl_sales_tax_adjustment WHERE id = ? AND deleted_at IS NULL`,
      [id]
    )
  );
  if (!doc) return structural("gl_sales_tax_adjustment not found");
  if (doc.qb_txn_id) return structural(`already in QuickBooks as ${doc.qb_txn_id}`);
  if (doc.status !== "posted") return structural(`gl_sales_tax_adjustment status is '${doc.status}', expected 'posted'`);
  if (!doc.vendor_list_id) return structural("sales_tax_vendor_missing: the adjustment has no tax vendor ListID");
  const accounts = await resolveAccounts(db, [doc.payable_list_id, doc.offset_account_list_id]);
  if (!accounts.ok) return structural(accounts.reason);

  const amount = BigInt(doc.amount_cents);
  const memo = [doc.reason?.trim(), doc.memo?.trim()].filter(Boolean).join(" - ") || `Sales Tax Adjustment ${doc.period}`;
  const payable: JournalLineInput = {
    side: doc.direction === "decrease" ? "debit" : "credit",
    accountListId: doc.payable_list_id,
    amountCents: amount,
    memo,
    entityListId: doc.vendor_list_id,
  };
  const offset: JournalLineInput = {
    side: doc.direction === "decrease" ? "credit" : "debit",
    accountListId: doc.offset_account_list_id,
    amountCents: amount,
    memo,
  };
  try {
    const qbxml = buildJournalEntryAddQbxml({
      txnDate: doc.day,
      refNumber: toQbRefNumber(doc.doc_number),
      lines: doc.direction === "decrease" ? [payable, offset] : [offset, payable],
    });
    return { ready: true, qbxml, qbTxnType: "JournalEntry", blockingReferenceIds: [] };
  } catch (error) {
    return structural(error instanceof Error ? error.message : "could not build the adjustment QBXML");
  }
}

interface PaymentRow {
  id: string;
  doc_number: string;
  period: string;
  day: string;
  bank_account_list_id: string;
  vendor_list_id: string | null;
  vendor_name: string;
  tax_item_list_id: string | null;
  reference: string | null;
  memo: string | null;
  status: string;
  qb_txn_id: string | null;
}

interface PaymentLineRow {
  kind: "tax" | "adjustment";
  item_sales_tax_list_id: string | null;
  adjustment_id: string | null;
  amount_cents: string;
  adjustment_qb_txn_id: string | null;
}

export async function salesTaxPaymentFacts(db: GlDocumentDb, id: string): Promise<GlDocumentAddFacts> {
  const doc = one<PaymentRow>(
    await db.raw(
      `SELECT id, doc_number, period, day::text AS day, bank_account_list_id, vendor_list_id, vendor_name,
              tax_item_list_id, reference, memo, status, qb_txn_id
         FROM gl_sales_tax_payment WHERE id = ? AND deleted_at IS NULL`,
      [id]
    )
  );
  if (!doc) return structural("gl_sales_tax_payment not found");
  if (doc.qb_txn_id) return structural(`already in QuickBooks as ${doc.qb_txn_id}`);
  if (doc.status !== "posted") return structural(`gl_sales_tax_payment status is '${doc.status}', expected 'posted'`);
  if (!doc.vendor_list_id) return structural("sales_tax_vendor_missing: the payment has no tax vendor ListID");
  if (!doc.tax_item_list_id) return structural("sales_tax_item_missing: the payment has no ItemSalesTax ListID");
  const accounts = await resolveAccounts(db, [doc.bank_account_list_id]);
  if (!accounts.ok) return structural(accounts.reason);

  const rows = (
    await db.raw(
      `SELECT l.kind, l.item_sales_tax_list_id, l.adjustment_id, l.amount_cents::text AS amount_cents,
              a.qb_txn_id AS adjustment_qb_txn_id
         FROM gl_sales_tax_payment_line l
         LEFT JOIN gl_sales_tax_adjustment a ON a.id = l.adjustment_id
        WHERE l.payment_id = ? ORDER BY l.sort_order ASC`,
      [id]
    )
  ).rows as PaymentLineRow[];
  if (rows.length === 0 || rows[0]!.kind !== "tax") return structural("gl_sales_tax_payment has no tax line");

  const blocking = rows.filter((r) => r.kind === "adjustment" && !r.adjustment_qb_txn_id).map((r) => r.adjustment_id!);
  if (blocking.length > 0) return transient(`waiting on QuickBooks TxnID for adjustments: ${blocking.join(", ")}`, blocking);

  const lines: SalesTaxPaymentLineInput[] = rows.map((r) => ({
    itemSalesTaxListId: r.kind === "tax" ? r.item_sales_tax_list_id : null,
    amountCents: BigInt(r.amount_cents),
  }));
  try {
    // Sin memo: el Add no lo admite en qbXML ≤ 11.0 (ver el builder).
    const qbxml = buildSalesTaxPaymentCheckAddQbxml({
      payeeListId: doc.vendor_list_id,
      txnDate: doc.day,
      bankAccountListId: doc.bank_account_list_id,
      refNumber: doc.reference ? toQbRefNumber(doc.reference) : null,
      lines,
    });
    return { ready: true, qbxml, qbTxnType: "SalesTaxPaymentCheck", blockingReferenceIds: [] };
  } catch (error) {
    return structural(error instanceof Error ? error.message : "could not build the sales tax payment QBXML");
  }
}
