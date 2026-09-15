/**
 * src/lib/qb-backfill/bank-queries.ts — lecturas QBXML de los documentos
 * BANCARIOS de QuickBooks (plan adopt-qb-bank-documents-20260915):
 *
 *   CheckQueryRq / CreditCardChargeQueryRq / CreditCardCreditQueryRq
 *     → TxnDateRangeFilter + IncludeLineItems (orden del DTD: el filtro PRIMERO).
 *
 * Lo que se usa de cada `*Ret`: TxnID, EditSequence, RefNumber, Memo,
 * IsToBePrinted, `PayeeEntityRef` (ListID + FullName — el payee exacto, sin
 * adivinar por nombre) y por línea `ExpenseLineRet`/`ItemLineRet` el Memo,
 * `CustomerRef` y `BillableStatus`. `TransferQueryRq` NO se parsea en el bridge
 * (10.0/11.0, sondeado 2026-09-14): los Transfer no tienen payee y no se piden.
 *
 * Read-only: nada acá escribe en QuickBooks.
 */
import { asList, directQuery } from "./qb-client";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function envelope(body: string): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?><?qbxml version="10.0"?>` +
    `<QBXML><QBXMLMsgsRq onError="stopOnError">${body}</QBXMLMsgsRq></QBXML>`
  );
}

function dateRange(from: string, to: string): string {
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) throw new Error(`fecha inválida: ${from}..${to}`);
  return `<TxnDateRangeFilter><FromTxnDate>${from}</FromTxnDate><ToTxnDate>${to}</ToTxnDate></TxnDateRangeFilter>`;
}

export type BankQueryType = "Check" | "CreditCardCharge" | "CreditCardCredit";

export function buildBankDocumentQbxml(type: BankQueryType, from: string, to: string): string {
  return envelope(`<${type}QueryRq requestID="1">${dateRange(from, to)}<IncludeLineItems>true</IncludeLineItems></${type}QueryRq>`);
}

export interface QbBankDocumentLine {
  memo: string | null;
  customer_list_id: string | null;
  billable: boolean;
}

export interface QbBankDocument {
  txn_id: string;
  txn_type: BankQueryType;
  edit_sequence: string | null;
  txn_date: string | null;
  ref_number: string | null;
  memo: string | null;
  is_to_be_printed: boolean;
  payee_list_id: string | null;
  payee_full_name: string | null;
  account_list_id: string | null;
  lines: QbBankDocumentLine[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = Record<string, any>;

function lineOf(raw: Raw): QbBankDocumentLine {
  return {
    memo: raw.Memo ?? null,
    customer_list_id: raw.CustomerRef?.ListID ?? null,
    billable: raw.BillableStatus === "Billable",
  };
}

export function normalizeBankDocuments(type: BankQueryType, rs: Record<string, unknown> | null): QbBankDocument[] {
  if (!rs) return [];
  return asList<Raw>((rs as Raw)[`${type}Ret`]).map((r) => ({
    txn_id: r.TxnID,
    txn_type: type,
    edit_sequence: r.EditSequence ?? null,
    txn_date: r.TxnDate ?? null,
    ref_number: r.RefNumber ?? null,
    memo: r.Memo ?? null,
    is_to_be_printed: r.IsToBePrinted === "true",
    payee_list_id: r.PayeeEntityRef?.ListID ?? null,
    payee_full_name: r.PayeeEntityRef?.FullName ?? null,
    account_list_id: r.AccountRef?.ListID ?? null,
    lines: [...asList<Raw>(r.ExpenseLineRet), ...asList<Raw>(r.ItemLineRet)].map(lineOf),
  }));
}

/** Ventanas mensuales [from, to] recortadas a la ventana pedida. */
export function monthlyWindows(from: string, to: string): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  let cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end) {
    const y = cursor.getUTCFullYear(), m = cursor.getUTCMonth();
    const last = new Date(Date.UTC(y, m + 1, 0));
    const wFrom = cursor.toISOString().slice(0, 10);
    const wTo = (last < end ? last : end).toISOString().slice(0, 10);
    out.push({ from: wFrom, to: wTo });
    cursor = new Date(Date.UTC(y, m + 1, 1));
  }
  return out;
}

/**
 * Trae los tres tipos por ventana mensual, con caché en disco por
 * (tipo, ventana). Devuelve un índice por TxnID. Una ventana que falla se
 * reporta y se sigue: el caller resuelve por nombre lo que falte.
 */
export async function fetchBankDocuments(opts: {
  from: string;
  to: string;
  cacheDir: string;
  log: (line: string) => void;
}): Promise<Map<string, QbBankDocument>> {
  const index = new Map<string, QbBankDocument>();
  const types: BankQueryType[] = ["Check", "CreditCardCharge", "CreditCardCredit"];
  for (const window of monthlyWindows(opts.from, opts.to)) {
    for (const type of types) {
      const cacheKey = `${type}_${window.from}_${window.to}`;
      try {
        const { rs, cached } = await directQuery(buildBankDocumentQbxml(type, window.from, window.to), `${type}QueryRs`, {
          cacheDir: opts.cacheDir,
          cacheKey,
          log: opts.log,
        });
        const docs = normalizeBankDocuments(type, rs);
        for (const d of docs) index.set(d.txn_id, d);
        opts.log(`  QB ${type} ${window.from}..${window.to}: ${docs.length}${cached ? " (cache)" : ""}`);
      } catch (err) {
        opts.log(`  QB ${type} ${window.from}..${window.to}: FALLÓ — ${(err as Error).message.slice(0, 120)}`);
      }
    }
  }
  return index;
}
