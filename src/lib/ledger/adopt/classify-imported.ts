/**
 * adopt-qb-bank-documents — clasificador PURO de un documento bancario importado
 * de QuickBooks (`bank_journal_entry.source_kind='qb_import'`, tipo Check /
 * Credit Card Charge / Credit Card Credit / Transfer) al documento nativo que lo
 * va a adoptar: `gl_check` (check | expense | card_charge) o `gl_transfer`.
 *
 * Decide por la FORMA de las líneas del asiento, no por el nombre del tipo: en
 * QuickBooks un traspaso entre cuentas propias vive como Check ("Daily Split",
 * cheque a la tarjeta) o como Credit Card Credit (pago de la tarjeta cargado
 * como crédito), y un Transfer puede ir de un pasivo a un banco. Medido sobre
 * el clon de prod del 2026-09-14 (919 documentos 2026): docs/QB_BANK_DOCUMENTS_ADOPTION.md.
 *
 * Reglas:
 * - Neto por cuenta (Σdebe − Σhaber). Las cuentas que netean a 0 no cuentan.
 * - `gl_transfer` si quedan EXACTAMENTE dos cuentas con neto (una sale, otra
 *   entra) y las dos son Bank/CreditCard — o, para el tipo `Transfer` de QB,
 *   cualquier par de `TRANSFER_ACCOUNT_TYPES`. Variante con fee: una tercera
 *   cuenta Expense con neto positivo. `net=true` cuando el asiento tiene más
 *   líneas que el par (Daily Split): el header lleva el neto y las líneas del
 *   asiento quedan como están.
 * - Si no, `gl_check`: la cuenta de banco/tarjeta es la ÚNICA Bank/CreditCard
 *   con neto negativo; total = −neto; las demás líneas viajan con signo
 *   (debe +, haber −), una por línea del asiento. Total ≤ 0 → `unmapped`
 *   (un refund real de tarjeta no cabe en `gl_check`).
 * - `kind` = `deriveBankCheckKind(tipo de cuenta, número)` — la misma regla
 *   que un documento creado en el POS.
 */
import { TRANSFER_ACCOUNT_TYPES } from "../lines/bank-transfer";
import { deriveBankCheckKind, type BankCheckKind } from "../lines/bank-check";

export interface ImportedAccount {
  id: string;
  name: string;
  account_type: string;
}

export interface ImportedLine {
  line_id: string;
  account: ImportedAccount;
  debit_cents: bigint;
  credit_cents: bigint;
  memo: string | null;
}

export interface ImportedBankEntry {
  entry_id: string;
  /** TxnID de QuickBooks (= `source_id`). */
  txn_id: string;
  txn_type: string;
  day: string;
  ref_number: string | null;
  /** Columna Name del reporte: el payee (o "Ecopowertech Inc" en traspasos). */
  name: string | null;
  memo: string | null;
  lines: ImportedLine[];
}

export type AdoptionFlag = "own_accounts_split" | "long_ref_number";

export interface CheckAdoption {
  target: "gl_check";
  kind: BankCheckKind;
  number: string | null;
  bank_account: ImportedAccount;
  total_cents: bigint;
  lines: Array<{ account: ImportedAccount; amount_cents: bigint; memo: string | null }>;
  flags: AdoptionFlag[];
}

export interface TransferAdoption {
  target: "gl_transfer";
  from: ImportedAccount;
  to: ImportedAccount;
  amount_cents: bigint;
  fee_cents: bigint;
  fee_account: ImportedAccount | null;
  /** true = el asiento tiene más líneas que el par: el header lleva el NETO. */
  net: boolean;
  line_count: number;
}

export type UnmappedReason = "txn_type" | "total_not_positive" | "no_single_bank_side";

export interface UnmappedAdoption {
  target: "unmapped";
  reason: UnmappedReason;
  detail: string;
}

export type AdoptionDecision = CheckAdoption | TransferAdoption | UnmappedAdoption;

export const ADOPTABLE_TXN_TYPES: ReadonlySet<string> = new Set([
  "Check",
  "Credit Card Charge",
  "Credit Card Credit",
  "Transfer",
]);

const REF_PLACEHOLDERS = new Set(["", "n/a", "na", "-", "—", "none"]);
const OWN_ACCOUNT_TYPES: ReadonlySet<string> = new Set(["Bank", "CreditCard"]);

/** Un RefNumber que el operador dejó como marcador no es un número de cheque. */
export function normalizeRefNumber(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  return REF_PLACEHOLDERS.has(value.toLowerCase()) ? null : value;
}

interface NetAccount {
  account: ImportedAccount;
  net: bigint;
}

function netByAccount(lines: ImportedLine[]): NetAccount[] {
  const map = new Map<string, NetAccount>();
  for (const line of lines) {
    const current = map.get(line.account.id) ?? { account: line.account, net: 0n };
    current.net += line.debit_cents - line.credit_cents;
    map.set(line.account.id, current);
  }
  return [...map.values()].filter((n) => n.net !== 0n);
}

function transferOf(entry: ImportedBankEntry, nets: NetAccount[]): TransferAdoption | null {
  const allowed = (a: ImportedAccount) =>
    entry.txn_type === "Transfer"
      ? (TRANSFER_ACCOUNT_TYPES as readonly string[]).includes(a.account_type)
      : OWN_ACCOUNT_TYPES.has(a.account_type);
  const outs = nets.filter((n) => n.net < 0n);
  const ins = nets.filter((n) => n.net > 0n);
  if (outs.length !== 1) return null;
  const from = outs[0]!;
  if (!allowed(from.account)) return null;
  const own = ins.filter((n) => allowed(n.account));
  const fees = ins.filter((n) => !allowed(n.account));
  if (own.length !== 1) return null;
  if (fees.length > 1 || (fees.length === 1 && fees[0]!.account.account_type !== "Expense")) return null;
  const to = own[0]!;
  const fee = fees[0] ?? null;
  return {
    target: "gl_transfer",
    from: from.account,
    to: to.account,
    amount_cents: -from.net,
    fee_cents: fee ? fee.net : 0n,
    fee_account: fee?.account ?? null,
    net: entry.lines.length > (fee ? 3 : 2),
    line_count: entry.lines.length,
  };
}

function checkOf(entry: ImportedBankEntry, nets: NetAccount[]): CheckAdoption | UnmappedAdoption {
  const bankSides = nets.filter((n) => n.net < 0n && OWN_ACCOUNT_TYPES.has(n.account.account_type));
  if (bankSides.length !== 1)
    return {
      target: "unmapped",
      reason: "no_single_bank_side",
      detail: bankSides.map((n) => n.account.name).join(" | ") || "sin cuenta Bank/CreditCard acreditada",
    };
  const bank = bankSides[0]!;
  const total = -bank.net;
  if (total <= 0n) return { target: "unmapped", reason: "total_not_positive", detail: total.toString() };
  const lines = entry.lines
    .filter((l) => l.account.id !== bank.account.id)
    .map((l) => ({ account: l.account, amount_cents: l.debit_cents - l.credit_cents, memo: l.memo }));
  const number = normalizeRefNumber(entry.ref_number);
  const flags: AdoptionFlag[] = [];
  if (lines.some((l) => OWN_ACCOUNT_TYPES.has(l.account.account_type))) flags.push("own_accounts_split");
  if (number && number.length > 8) flags.push("long_ref_number");
  return {
    target: "gl_check",
    kind: deriveBankCheckKind(bank.account.account_type, number),
    number,
    bank_account: bank.account,
    total_cents: total,
    lines,
    flags,
  };
}

export function classifyImportedBankDocument(entry: ImportedBankEntry): AdoptionDecision {
  if (!ADOPTABLE_TXN_TYPES.has(entry.txn_type))
    return { target: "unmapped", reason: "txn_type", detail: entry.txn_type };
  const nets = netByAccount(entry.lines);
  const negatives = nets.filter((n) => n.net < 0n).length;
  // Un refund real de tarjeta (Dr tarjeta / Cr gasto) no tiene lado bancario que
  // acredite: cae por `total_not_positive`, no por falta de forma.
  const transfer = transferOf(entry, nets);
  if (transfer) return transfer;
  const check = checkOf(entry, nets);
  if (check.target === "unmapped" && check.reason === "no_single_bank_side" && negatives === 1) {
    const only = nets.find((n) => n.net < 0n)!;
    if (only.account.account_type !== "Bank" && only.account.account_type !== "CreditCard")
      return { target: "unmapped", reason: "total_not_positive", detail: `acredita ${only.account.name}` };
  }
  return check;
}
