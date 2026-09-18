/**
 * qbxml-mod-builders.ts — `CheckModRq` / `CreditCardChargeModRq` de un
 * `gl_check` corregido en el lugar (plan check-revise-20260918). PUROS: sin IO.
 *
 * Semántica qbXML de un Mod con líneas: una `ExpenseLineMod` con su `TxnLineID`
 * actualiza esa línea, `TxnLineID = -1` agrega una, y `ClearExpenseLines=true`
 * borra todas las existentes antes de aplicar las `ExpenseLineMod`. El POS no
 * guarda los TxnLineID de las líneas del cheque (ni los de los 683 adoptados),
 * así que el Mod SIEMPRE manda `ClearExpenseLines` + el set completo como
 * líneas nuevas: QuickBooks queda con exactamente lo que el POS tiene.
 *
 * Orden de elementos (load-bearing: 0x80040400 ante un orden equivocado; se
 * sondea contra el company file con un TxnID inexistente + control negativo
 * antes de confiar, como `vendor-credit-mod.ts` el 2026-09-11):
 *
 *   CheckMod:            TxnID → EditSequence → AccountRef → PayeeEntityRef →
 *                        RefNumber → TxnDate → Memo → IsToBePrinted →
 *                        ClearExpenseLines → ExpenseLineMod*
 *   CreditCardChargeMod: TxnID → EditSequence → AccountRef → PayeeEntityRef →
 *                        TxnDate → RefNumber → Memo → ClearExpenseLines →
 *                        ExpenseLineMod*
 *
 * Los Mod siguen el MISMO orden que sus Add: Check lleva RefNumber ANTES de
 * TxnDate, CreditCardCharge al revés. Sondeado contra el company file el
 * 2026-09-18 (`scripts/debug/probe-check-mod-qbxml.ts`, TxnID inexistente):
 * CheckMod con TxnDate antes de RefNumber → 0x80040400; con RefNumber antes →
 * 3120 "cannot be found" (parseó), y en esa forma `IsToBePrinted`,
 * `ClearExpenseLines` y `ExpenseLineMod` con `TxnLineID -1` también parsean.
 *
 * Si algún día se guardan los TxnLineID, `ExpenseLineMod` acepta `txnLineId`
 * por línea y el `ClearExpenseLines` se vuelve opcional — la forma está lista.
 */

import { centsToDollarsString } from "../../ledger/money";
import { escapeXml, qbxmlEnvelope } from "../qbxml-escape";

import type { ExpenseLineInput, GlQbTxnType } from "./qbxml-builders";

const tag = (name: string, value: string | null | undefined): string =>
  value == null || value === "" ? "" : `<${name}>${escapeXml(value)}</${name}>`;

const ref = (name: string, listId: string | null | undefined): string =>
  listId ? `<${name}>${tag("ListID", listId)}</${name}>` : "";

const toBigInt = (cents: bigint | number): bigint =>
  typeof cents === "bigint" ? cents : BigInt(Math.round(cents));

export interface ExpenseLineModInput extends ExpenseLineInput {
  /** TxnLineID existente en QB; null = línea nueva (`-1`). */
  txnLineId?: string | null;
}

export interface CheckModInput {
  txnId: string;
  editSequence: string;
  bankAccountListId: string;
  payeeListId?: string | null;
  /** `YYYY-MM-DD` */
  txnDate: string;
  refNumber?: string | null;
  memo?: string | null;
  isToBePrinted: boolean;
  /** Set COMPLETO de líneas: las existentes en QB se borran (`ClearExpenseLines`). */
  lines: ExpenseLineModInput[];
}

export type CreditCardChargeModInput = Omit<CheckModInput, "isToBePrinted">;

/** Tipos que hoy saben corregirse en el lugar; el resto sigue siendo void + documento nuevo. */
export const GL_MOD_CAPABLE_TXN_TYPES: readonly GlQbTxnType[] = ["Check", "CreditCardCharge"];

function assertModHeader(input: { txnId: string; editSequence: string; txnDate: string; bankAccountListId: string }, rq: string): void {
  if (!input.txnId) throw new Error(`${rq} requires a TxnID`);
  if (!input.editSequence) throw new Error(`${rq} requires an EditSequence`);
  if (!input.bankAccountListId) throw new Error(`${rq} requires the AccountRef ListID`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.txnDate)) {
    throw new Error(`${rq} requires TxnDate as YYYY-MM-DD (got '${input.txnDate}')`);
  }
}

function assertModLines(lines: ExpenseLineModInput[], rq: string): void {
  if (lines.length === 0) throw new Error(`${rq} requires at least one ExpenseLineMod`);
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
 * ExpenseLineMod: TxnLineID → AccountRef → Amount → Memo → CustomerRef → BillableStatus.
 * `BillableStatus` sólo cuando la línea es de verdad facturable (misma regla que
 * `expenseLineXml` del Add: QB rechaza `NotBillable` en una línea no reembolsable).
 */
function expenseLineModXml(line: ExpenseLineModInput): string {
  const billable =
    line.customerListId && line.billable === true ? tag("BillableStatus", "Billable") : "";
  return (
    `<ExpenseLineMod>` +
    tag("TxnLineID", line.txnLineId ?? "-1") +
    ref("AccountRef", line.accountListId) +
    `<Amount>${centsToDollarsString(line.amountCents)}</Amount>` +
    tag("Memo", line.memo) +
    ref("CustomerRef", line.customerListId) +
    billable +
    `</ExpenseLineMod>`
  );
}

export function buildCheckModQbxml(input: CheckModInput): string {
  const rq = "CheckModRq";
  assertModHeader(input, rq);
  assertModLines(input.lines, rq);
  const body =
    tag("TxnID", input.txnId) +
    tag("EditSequence", input.editSequence) +
    ref("AccountRef", input.bankAccountListId) +
    ref("PayeeEntityRef", input.payeeListId) +
    tag("RefNumber", input.refNumber) +
    tag("TxnDate", input.txnDate) +
    tag("Memo", input.memo) +
    `<IsToBePrinted>${input.isToBePrinted ? "true" : "false"}</IsToBePrinted>` +
    `<ClearExpenseLines>true</ClearExpenseLines>` +
    input.lines.map(expenseLineModXml).join("");
  return qbxmlEnvelope(`<CheckModRq><CheckMod>${body}</CheckMod></CheckModRq>`);
}

export function buildCreditCardChargeModQbxml(input: CreditCardChargeModInput): string {
  const rq = "CreditCardChargeModRq";
  assertModHeader(input, rq);
  assertModLines(input.lines, rq);
  const body =
    tag("TxnID", input.txnId) +
    tag("EditSequence", input.editSequence) +
    ref("AccountRef", input.bankAccountListId) +
    ref("PayeeEntityRef", input.payeeListId) +
    tag("TxnDate", input.txnDate) +
    tag("RefNumber", input.refNumber) +
    tag("Memo", input.memo) +
    `<ClearExpenseLines>true</ClearExpenseLines>` +
    input.lines.map(expenseLineModXml).join("");
  return qbxmlEnvelope(
    `<CreditCardChargeModRq><CreditCardChargeMod>${body}</CreditCardChargeMod></CreditCardChargeModRq>`
  );
}

/** `<Tipo>QueryRq` por TxnID — lo que el despachador manda para leer el EditSequence fresco. */
export function buildGlDocumentQueryQbxml(type: GlQbTxnType, txnId: string): string {
  if (!txnId) throw new Error(`${type}QueryRq requires a TxnID`);
  return qbxmlEnvelope(`<${type}QueryRq>${tag("TxnID", txnId)}</${type}QueryRq>`);
}

/** `<Tipo>ModRq` / `<Tipo>ModRs` — derivados del tipo, como los del Add. */
export const glQbModResponseTag = (type: GlQbTxnType): string => `${type}ModRs`;
export const glQbQueryResponseTag = (type: GlQbTxnType): string => `${type}QueryRs`;
