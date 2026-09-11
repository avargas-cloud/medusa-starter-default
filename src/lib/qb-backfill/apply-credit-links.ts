/**
 * src/lib/qb-backfill/apply-credit-links.ts
 *
 * Aplicaciones de Vendor Credits a bills, reconstruidas desde QuickBooks.
 *
 * En QB un bill "pagado" con un crédito no tiene BillPayment: el crédito
 * aparece como `LinkedTxn TxnType=VendorCredit` del bill (y el bill como
 * `LinkedTxn TxnType=Bill` del crédito), con `Amount` negativo = lo aplicado.
 * Medido en el sandbox 2026-09-11: 34 créditos aplicados a 81 bills
 * ($62.271,23) y 49 bills marcados pagados en QB SIN ningún pago en el POS —
 * eran todos créditos. Sin estas filas, `computeBillBalance` (Pay Bills,
 * payables) los muestra abiertos y los créditos íntegros disponibles.
 *
 * Idempotente por par (credit, bill): el POS no tiene índice único, así que se
 * mira `vendor_credit_application` viva antes de insertar. `applied_at` = la
 * fecha más tardía de los dos documentos (una aplicación no puede preceder a
 * ninguno; QB no informa la fecha real de la aplicación).
 */
import { ulid } from "ulid";
import type { QbBill, QbLinkedTxn, QbVendorCredit } from "./types";

export interface LocalCreditRef {
  id: string;
  vendor_id: string | null;
  total_cents: number;
  credit_date: string; // YYYY-MM-DD
}
export interface LocalBillRef {
  id: string;
  vendor_id: string | null;
  document_date: string; // YYYY-MM-DD
}

export interface CreditApplicationPlanRow {
  credit_txn_id: string;
  bill_txn_id: string;
  credit_id: string;
  vendor_bill_id: string;
  amount_cents: number;
  applied_at: string; // YYYY-MM-DD
}
export interface CreditApplicationSkip {
  credit_txn_id: string;
  bill_txn_id: string;
  reason: "already" | "credit_missing" | "bill_missing" | "vendor_mismatch" | "zero_amount" | "exceeds_credit";
}
export interface CreditApplicationPlan {
  rows: CreditApplicationPlanRow[];
  skipped: CreditApplicationSkip[];
}

export function pairKey(creditId: string, billId: string): string {
  return `${creditId}\t${billId}`;
}

/** Une los dos lados del enlace (bill→credit y credit→bill) en pares únicos. */
export function collectCreditLinks(
  bills: readonly QbBill[],
  credits: readonly QbVendorCredit[]
): Map<string, { credit_txn_id: string; bill_txn_id: string; amount_cents: number }> {
  const pairs = new Map<string, { credit_txn_id: string; bill_txn_id: string; amount_cents: number }>();
  const add = (creditTxn: string, billTxn: string, link: QbLinkedTxn): void => {
    const key = pairKey(creditTxn, billTxn);
    if (pairs.has(key)) return;
    pairs.set(key, { credit_txn_id: creditTxn, bill_txn_id: billTxn, amount_cents: Math.abs(link.amount_cents ?? 0) });
  };
  for (const bill of bills) {
    for (const l of bill.linked_txns) if (l.txn_type === "VendorCredit") add(l.txn_id, bill.txn_id, l);
  }
  for (const credit of credits) {
    for (const l of credit.linked_txns) if (l.txn_type === "Bill") add(credit.txn_id, l.txn_id, l);
  }
  return pairs;
}

export function planCreditApplications(
  bills: readonly QbBill[],
  credits: readonly QbVendorCredit[],
  creditIndex: ReadonlyMap<string, LocalCreditRef>, // por qb_txn_id
  billIndex: ReadonlyMap<string, LocalBillRef>, // por qb_txn_id
  existingPairs: ReadonlySet<string> // pairKey(credit_id, vendor_bill_id) de aplicaciones vivas
): CreditApplicationPlan {
  const rows: CreditApplicationPlanRow[] = [];
  const skipped: CreditApplicationSkip[] = [];
  const plannedByCredit = new Map<string, number>();
  for (const link of collectCreditLinks(bills, credits).values()) {
    const base = { credit_txn_id: link.credit_txn_id, bill_txn_id: link.bill_txn_id };
    const credit = creditIndex.get(link.credit_txn_id);
    const bill = billIndex.get(link.bill_txn_id);
    if (!credit) { skipped.push({ ...base, reason: "credit_missing" }); continue; }
    if (!bill) { skipped.push({ ...base, reason: "bill_missing" }); continue; }
    if (existingPairs.has(pairKey(credit.id, bill.id))) { skipped.push({ ...base, reason: "already" }); continue; }
    if (!(link.amount_cents > 0)) { skipped.push({ ...base, reason: "zero_amount" }); continue; }
    if (credit.vendor_id && bill.vendor_id && credit.vendor_id !== bill.vendor_id) {
      skipped.push({ ...base, reason: "vendor_mismatch" });
      continue;
    }
    const planned = (plannedByCredit.get(credit.id) ?? 0) + link.amount_cents;
    if (planned > credit.total_cents) { skipped.push({ ...base, reason: "exceeds_credit" }); continue; }
    plannedByCredit.set(credit.id, planned);
    rows.push({
      ...base,
      credit_id: credit.id,
      vendor_bill_id: bill.id,
      amount_cents: link.amount_cents,
      applied_at: credit.credit_date > bill.document_date ? credit.credit_date : bill.document_date,
    });
  }
  return { rows, skipped };
}

interface QueryClient {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

export async function loadCreditApplicationIndexes(client: QueryClient): Promise<{
  creditIndex: Map<string, LocalCreditRef>;
  billIndex: Map<string, LocalBillRef>;
  existingPairs: Set<string>;
}> {
  const { rows: cr } = await client.query(
    `SELECT id, vendor_id, total_cents::bigint AS total_cents, qb_txn_id,
            to_char(credit_date, 'YYYY-MM-DD') AS credit_date -- columna date, sin zona
       FROM vendor_credit WHERE deleted_at IS NULL AND qb_txn_id IS NOT NULL AND status = 'posted'`
  );
  const creditIndex = new Map<string, LocalCreditRef>();
  for (const r of cr as Array<LocalCreditRef & { qb_txn_id: string; total_cents: string | number }>) {
    creditIndex.set(r.qb_txn_id, { id: r.id, vendor_id: r.vendor_id, total_cents: Number(r.total_cents), credit_date: r.credit_date });
  }
  const { rows: br } = await client.query(
    `SELECT id, vendor_id, qb_txn_id,
            to_char(document_date AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS document_date
       FROM vendor_bill WHERE deleted_at IS NULL AND qb_txn_id IS NOT NULL AND status IN ('confirmed','synced')`
  );
  const billIndex = new Map<string, LocalBillRef>();
  for (const r of br as Array<LocalBillRef & { qb_txn_id: string }>) {
    billIndex.set(r.qb_txn_id, { id: r.id, vendor_id: r.vendor_id, document_date: r.document_date });
  }
  const { rows: ex } = await client.query(
    `SELECT credit_id, vendor_bill_id FROM vendor_credit_application WHERE voided_at IS NULL`
  );
  const existingPairs = new Set((ex as Array<{ credit_id: string; vendor_bill_id: string }>).map((r) => pairKey(r.credit_id, r.vendor_bill_id)));
  return { creditIndex, billIndex, existingPairs };
}

/** Inserta las aplicaciones planeadas en UNA transacción y recalcula `applied_cents` de los créditos tocados. */
export async function applyCreditApplications(
  client: QueryClient,
  plan: CreditApplicationPlan,
  runId: string
): Promise<{ inserted: number; credits_touched: number }> {
  if (plan.rows.length === 0) return { inserted: 0, credits_touched: 0 };
  const touched = new Set<string>();
  await client.query("BEGIN");
  try {
    for (const row of plan.rows) {
      await client.query(
        `INSERT INTO vendor_credit_application (id, credit_id, vendor_bill_id, amount_cents, applied_at, applied_by)
         VALUES ($1, $2, $3, $4, ($5::date + interval '16 hours')::timestamptz, $6)`,
        [`vcap_${ulid().toLowerCase()}`, row.credit_id, row.vendor_bill_id, row.amount_cents, row.applied_at, `qb_backfill:${runId}`]
      );
      touched.add(row.credit_id);
    }
    // applied_cents se RECALCULA desde las filas vivas (no se suma): idempotente ante re-corridas.
    await client.query(
      `UPDATE vendor_credit vc SET applied_cents = s.applied, updated_at = now()
         FROM (SELECT credit_id, COALESCE(SUM(amount_cents), 0)::bigint AS applied
                 FROM vendor_credit_application WHERE voided_at IS NULL AND credit_id = ANY($1::text[]) GROUP BY credit_id) s
        WHERE vc.id = s.credit_id`,
      [[...touched]]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  }
  return { inserted: plan.rows.length, credits_touched: touched.size };
}
