/**
 * qbxml-builders.ts — QBXML crudo de los documentos GL bancarios del POS
 * (plan gl-docs-to-qb-20260914). PUROS: sin IO, sin bridge.
 *
 * Cuatro documentos del POS se materializan en QuickBooks como CINCO tipos:
 *
 *   gl_check (kind check/expense, cuenta Bank)  → CheckAddRq
 *   gl_check (kind card_charge, cuenta CreditCard) → CreditCardChargeAddRq
 *   bank_deposit                                  → DepositAddRq
 *   gl_transfer (con o sin fee)                   → JournalEntryAddRq
 *   gl_journal_entry                              → JournalEntryAddRq
 *
 * POR QUÉ el transfer va como JournalEntry y no como TransferAdd: sondeado
 * read-only contra el company file el 2026-09-14 (TxnID inexistente + control
 * negativo): `TransferQueryRq` da 0x80040400 con envelope 10.0 y 11.0 (no
 * está en el esquema) y QuickBooks contesta 0x80040423 ("version not
 * supported") a CUALQUIER request con envelope 12.0 o 13.0 — que es donde
 * Transfer existe. Un asiento Dr destino / Cr origen es exactamente lo que
 * QuickBooks hace por dentro con un Transfer, y además admite la comisión
 * bancaria como tercera línea.
 *
 * El orden de los elementos es exacto y load-bearing (0x80040400 ante un
 * orden equivocado). Referencias: el builder tipado del bridge para CheckAdd
 * (`quickbooks-bridge/src/qbxml/builders/check.ts`) y JournalEntryAdd
 * (`journalEntry.ts`), y la spec qbXML 10.0 para Deposit y CreditCardCharge.
 *
 * Todo texto libre pasa por `escapeXml` (pliega a ASCII 7 bits: QB rechaza
 * cualquier otro byte, regla 2026-09-11). Los montos salen de
 * `centsToDollarsString` — nunca de un float.
 *
 * DISPATCH: `POST /api/sync/direct-query` con el envelope completo
 * (`qbxmlEnvelope`), igual que `vendor-credit-add.ts` / `bill-payment-add.ts`:
 * el bridge no tiene builder tipado para Deposit ni CreditCardCharge, y usar el
 * mismo camino para los cinco deja UNA sola rama de confirmación en
 * `poll-submitted-rows.ts`.
 */

import { centsToDollarsString } from "../../ledger/money";
import { escapeXml, qbxmlEnvelope } from "../qbxml-escape";

/** Tipo QB del documento creado — es lo que `TxnVoidRq` tiene que nombrar. */
export type GlQbTxnType =
  | "Check"
  | "CreditCardCharge"
  | "Deposit"
  | "JournalEntry";

/** `<Tipo>AddRq` / `<Tipo>AddRs` / `<Tipo>Ret` — derivados del tipo, nunca tipeados aparte. */
export const glQbRequestTag = (type: GlQbTxnType): string => `${type}AddRq`;
export const glQbResponseTag = (type: GlQbTxnType): string => `${type}AddRs`;
export const glQbRetTag = (type: GlQbTxnType): string => `${type}Ret`;

const tag = (name: string, value: string | null | undefined): string =>
  value == null || value === "" ? "" : `<${name}>${escapeXml(value)}</${name}>`;

const ref = (name: string, listId: string | null | undefined): string =>
  listId ? `<${name}>${tag("ListID", listId)}</${name}>` : "";

const amount = (name: string, cents: bigint | number): string =>
  `<${name}>${centsToDollarsString(cents)}</${name}>`;

const assertDate = (txnDate: string, rq: string): void => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(txnDate)) {
    throw new Error(`${rq} requires TxnDate as YYYY-MM-DD (got '${txnDate}')`);
  }
};

const toBigInt = (cents: bigint | number): bigint =>
  typeof cents === "bigint" ? cents : BigInt(Math.round(cents));

// ── Check / CreditCardCharge ────────────────────────────────────────────────

export interface ExpenseLineInput {
  accountListId: string;
  /** Positivo = gasto (Dr cuenta); negativo reduce. QB acepta líneas negativas mientras el total sea ≥ 0. */
  amountCents: bigint | number;
  memo?: string | null;
  /** ListID del cliente en QB (sólo si se pudo resolver; nunca un id del POS). */
  customerListId?: string | null;
  billable?: boolean;
}

export interface CheckAddInput {
  /** Cuenta Bank (ListID del espejo `qb_account`). */
  bankAccountListId: string;
  /** Vendor/Customer ListID en QB. Un payee libre ("other") va SIN ref: el nombre viaja en el memo. */
  payeeListId?: string | null;
  /** Número de cheque; null = gasto sin número (ACH/débito). */
  refNumber?: string | null;
  /** `YYYY-MM-DD` */
  txnDate: string;
  memo?: string | null;
  isToBePrinted: boolean;
  lines: ExpenseLineInput[];
}

export interface CreditCardChargeAddInput {
  /** Cuenta CreditCard (ListID del espejo `qb_account`). */
  cardAccountListId: string;
  payeeListId?: string | null;
  refNumber?: string | null;
  txnDate: string;
  memo?: string | null;
  lines: ExpenseLineInput[];
}

function assertExpenseLines(lines: ExpenseLineInput[], rq: string): void {
  if (lines.length === 0) throw new Error(`${rq} requires at least one ExpenseLineAdd`);
  let total = 0n;
  for (const [i, line] of lines.entries()) {
    if (!line.accountListId) throw new Error(`${rq} line ${i + 1} has no AccountRef ListID`);
    const cents = toBigInt(line.amountCents);
    if (cents === 0n) throw new Error(`${rq} line ${i + 1} has a zero amount`);
    total += cents;
  }
  if (total <= 0n) throw new Error(`${rq} total must be positive (got ${total} cents)`);
}

/**
 * ExpenseLineAdd: AccountRef → Amount → Memo → CustomerRef → BillableStatus.
 * `BillableStatus` sólo cuando la línea es de verdad facturable (`Billable`): QB rechaza
 * `NotBillable` en una línea que no puede ser reembolsable — un refund a un cliente contra
 * Accounts Receivable murió con 3210 "Target is not reimbursable" (CHK-0002, 2026-09-14).
 * Omitirlo es el default de QB (no facturable) para toda línea con CustomerRef.
 */
function expenseLineXml(line: ExpenseLineInput): string {
  const billable =
    line.customerListId && line.billable === true ? tag("BillableStatus", "Billable") : "";
  return (
    `<ExpenseLineAdd>` +
    ref("AccountRef", line.accountListId) +
    amount("Amount", line.amountCents) +
    tag("Memo", line.memo) +
    ref("CustomerRef", line.customerListId) +
    billable +
    `</ExpenseLineAdd>`
  );
}

/**
 * CheckAdd: AccountRef → PayeeEntityRef → RefNumber → TxnDate → Memo →
 * IsToBePrinted → ExpenseLineAdd*  (mismo orden que el builder tipado del bridge).
 */
export function buildCheckAddQbxml(input: CheckAddInput): string {
  const rq = "CheckAddRq";
  if (!input.bankAccountListId) throw new Error(`${rq} requires the bank AccountRef ListID`);
  assertDate(input.txnDate, rq);
  assertExpenseLines(input.lines, rq);
  const body =
    ref("AccountRef", input.bankAccountListId) +
    ref("PayeeEntityRef", input.payeeListId) +
    tag("RefNumber", input.refNumber) +
    tag("TxnDate", input.txnDate) +
    tag("Memo", input.memo) +
    `<IsToBePrinted>${input.isToBePrinted ? "true" : "false"}</IsToBePrinted>` +
    input.lines.map(expenseLineXml).join("");
  return qbxmlEnvelope(`<CheckAddRq><CheckAdd>${body}</CheckAdd></CheckAddRq>`);
}

/**
 * CreditCardChargeAdd: AccountRef → PayeeEntityRef → TxnDate → RefNumber →
 * Memo → ExpenseLineAdd*  (ojo: TxnDate ANTES de RefNumber, al revés que Check).
 */
export function buildCreditCardChargeAddQbxml(input: CreditCardChargeAddInput): string {
  const rq = "CreditCardChargeAddRq";
  if (!input.cardAccountListId) throw new Error(`${rq} requires the credit card AccountRef ListID`);
  assertDate(input.txnDate, rq);
  assertExpenseLines(input.lines, rq);
  const body =
    ref("AccountRef", input.cardAccountListId) +
    ref("PayeeEntityRef", input.payeeListId) +
    tag("TxnDate", input.txnDate) +
    tag("RefNumber", input.refNumber) +
    tag("Memo", input.memo) +
    input.lines.map(expenseLineXml).join("");
  return qbxmlEnvelope(
    `<CreditCardChargeAddRq><CreditCardChargeAdd>${body}</CreditCardChargeAdd></CreditCardChargeAddRq>`
  );
}

// ── Deposit ─────────────────────────────────────────────────────────────────

/** Un cobro que YA vive en Undeposited Funds de QuickBooks (SalesReceipt o ReceivePayment). */
export interface DepositPaymentLineInput {
  paymentTxnId: string;
}

/** Una línea directa: efectivo/otro sin cobro del POS, o la comisión (negativa) a su cuenta de gasto. */
export interface DepositAccountLineInput {
  accountListId: string;
  amountCents: bigint | number;
  memo?: string | null;
  checkNumber?: string | null;
  entityListId?: string | null;
}

export type DepositLineInput = DepositPaymentLineInput | DepositAccountLineInput;

export interface DepositAddInput {
  txnDate: string;
  /** Cuenta Bank destino. */
  depositToAccountListId: string;
  memo?: string | null;
  lines: DepositLineInput[];
}

const isPaymentLine = (l: DepositLineInput): l is DepositPaymentLineInput =>
  (l as DepositPaymentLineInput).paymentTxnId !== undefined;

/**
 * DepositLineAdd: (PaymentTxnID) | (EntityRef → AccountRef → Memo → CheckNumber → Amount).
 * Una línea de pago no lleva monto: QB toma el del cobro y lo saca de Undeposited Funds.
 */
function depositLineXml(line: DepositLineInput, index: number): string {
  if (isPaymentLine(line)) {
    if (!line.paymentTxnId) throw new Error(`DepositLineAdd ${index + 1} has no PaymentTxnID`);
    return `<DepositLineAdd>${tag("PaymentTxnID", line.paymentTxnId)}</DepositLineAdd>`;
  }
  if (!line.accountListId) throw new Error(`DepositLineAdd ${index + 1} has no AccountRef ListID`);
  if (toBigInt(line.amountCents) === 0n) throw new Error(`DepositLineAdd ${index + 1} has a zero amount`);
  return (
    `<DepositLineAdd>` +
    ref("EntityRef", line.entityListId) +
    ref("AccountRef", line.accountListId) +
    tag("Memo", line.memo) +
    tag("CheckNumber", line.checkNumber) +
    amount("Amount", line.amountCents) +
    `</DepositLineAdd>`
  );
}

/** DepositAdd: TxnDate → DepositToAccountRef → Memo → DepositLineAdd*. */
export function buildDepositAddQbxml(input: DepositAddInput): string {
  const rq = "DepositAddRq";
  if (!input.depositToAccountListId) throw new Error(`${rq} requires DepositToAccountRef ListID`);
  assertDate(input.txnDate, rq);
  if (input.lines.length === 0) throw new Error(`${rq} requires at least one DepositLineAdd`);
  const body =
    tag("TxnDate", input.txnDate) +
    ref("DepositToAccountRef", input.depositToAccountListId) +
    tag("Memo", input.memo) +
    input.lines.map(depositLineXml).join("");
  return qbxmlEnvelope(`<DepositAddRq><DepositAdd>${body}</DepositAdd></DepositAddRq>`);
}

// ── JournalEntry ────────────────────────────────────────────────────────────

export interface JournalLineInput {
  side: "debit" | "credit";
  accountListId: string;
  /** Siempre positivo: el lado lo da `side`. */
  amountCents: bigint | number;
  memo?: string | null;
  /** Obligatorio en QB cuando la cuenta es A/R o A/P. Lo exige `facts`, no este builder. */
  entityListId?: string | null;
}

export interface JournalEntryAddInput {
  txnDate: string;
  refNumber?: string | null;
  lines: JournalLineInput[];
}

/** JournalDebitLine / JournalCreditLine: AccountRef → Amount → Memo → EntityRef. */
function journalLineXml(line: JournalLineInput, index: number): string {
  const name = line.side === "debit" ? "JournalDebitLine" : "JournalCreditLine";
  if (!line.accountListId) throw new Error(`${name} ${index + 1} has no AccountRef ListID`);
  const cents = toBigInt(line.amountCents);
  if (cents <= 0n) throw new Error(`${name} ${index + 1} must be positive (got ${cents} cents)`);
  return (
    `<${name}>` +
    ref("AccountRef", line.accountListId) +
    amount("Amount", cents) +
    tag("Memo", line.memo) +
    ref("EntityRef", line.entityListId) +
    `</${name}>`
  );
}

/**
 * JournalEntryAdd: TxnDate → RefNumber → JournalDebitLine* → JournalCreditLine*.
 * Débitos primero, después créditos (orden del builder tipado del bridge, que
 * ya crea asientos reales). Balanceado o no se construye.
 */
export function buildJournalEntryAddQbxml(input: JournalEntryAddInput): string {
  const rq = "JournalEntryAddRq";
  assertDate(input.txnDate, rq);
  const debits = input.lines.filter((l) => l.side === "debit");
  const credits = input.lines.filter((l) => l.side === "credit");
  if (debits.length === 0 || credits.length === 0) {
    throw new Error(`${rq} requires at least one debit line and one credit line`);
  }
  const sum = (ls: JournalLineInput[]): bigint =>
    ls.reduce((acc, l) => acc + toBigInt(l.amountCents), 0n);
  if (sum(debits) !== sum(credits)) {
    throw new Error(`${rq} unbalanced: debits ${sum(debits)} cents vs credits ${sum(credits)} cents`);
  }
  const body =
    tag("TxnDate", input.txnDate) +
    tag("RefNumber", input.refNumber) +
    debits.map(journalLineXml).join("") +
    credits.map(journalLineXml).join("");
  return qbxmlEnvelope(
    `<JournalEntryAddRq><JournalEntryAdd>${body}</JournalEntryAdd></JournalEntryAddRq>`
  );
}
