import { LedgerAccount, LedgerError, LedgerLine } from "../types";

export type OpeningBalanceItemKind = "outstanding_check" | "deposit_in_transit";

export interface OpeningBalanceItem {
  key: string;
  kind: OpeningBalanceItemKind;
  original_day: string;
  amount_cents: bigint;
  reference: string;
  description?: string;
}

export interface OpeningBalanceInput {
  account: LedgerAccount;
  /**
   * Saldo en la dirección NORMAL de la cuenta (`account.normal_balance`):
   * el extracto para Bank, el de libros para el resto. Puede ser 0 SÓLO si
   * hay `items` (una cuenta Bank sin saldo neto pero con partidas pendientes).
   */
  balance_cents: bigint;
  items: OpeningBalanceItem[];
  equity: LedgerAccount;
}

/**
 * `role` vive bajo el CHECK `bank_journal_role`: `^[a-z][a-z0-9_]{0,79}$` —
 * minúsculas, dígitos y `_` únicamente, arrancando con letra. `key` puede
 * traer mayúsculas o `-` (el `[A-Za-z0-9_-]` del plan es el alfabeto de
 * ENTRADA); acá se normaliza al alfabeto de SALIDA que la columna admite, y
 * se trunca para que `uncleared_<key>` completo no pase de 80 chars.
 */
const ROLE_MAX_LENGTH = 80;
const ROLE_PREFIX = "uncleared_";

function sanitizeKey(key: string): string {
  const lowered = key.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  return lowered.slice(0, ROLE_MAX_LENGTH - ROLE_PREFIX.length);
}

/**
 * Banking-on-GL §2 — builder puro del documento `opening_balance`:
 * - `opening`: Dr/Cr `account` por `balance_cents`, según `normal_balance`.
 * - `uncleared_<key>` (sólo Bank): una por cheque pendiente (Cr account) o
 *   depósito en tránsito (Dr account).
 * - `equity`: UNA línea, la contrapartida neta de `opening` + todos los
 *   `items` (necesario porque `validateLines` exige roles únicos).
 */
export function buildOpeningBalanceLines(input: OpeningBalanceInput): LedgerLine[] {
  const { account, balance_cents, items, equity } = input;

  if (account.normal_balance !== "debit" && account.normal_balance !== "credit")
    throw new LedgerError("GL_SOURCE_INVALID", {
      reason: "account_normal_balance_missing",
    });
  // Un saldo NEGATIVO es una cuenta contra su dirección normal (depreciación
  // acumulada, AP con saldo deudor, sub-cuentas de VEETECH — el Balance Sheet
  // de QB al 2025-12-31 trae 11 así): se postea del lado opuesto. Sólo se
  // permite sin `items`: un banco en rojo con partidas pendientes es otro caso.
  if (balance_cents < 0n && items.length > 0)
    throw new LedgerError("GL_SOURCE_INVALID", {
      reason: "negative_balance_with_items",
      balance_cents: balance_cents.toString(),
    });
  if (balance_cents === 0n && items.length === 0)
    throw new LedgerError("GL_SOURCE_INVALID", { reason: "nothing_to_post" });
  if (items.length > 0 && account.account_type !== "Bank")
    throw new LedgerError("GL_SOURCE_INVALID", {
      reason: "items_on_non_bank_account",
      account_type: account.account_type,
    });

  const seenKeys = new Set<string>();
  for (const item of items) {
    const sanitized = sanitizeKey(item.key);
    if (seenKeys.has(sanitized))
      throw new LedgerError("GL_SOURCE_INVALID", {
        reason: "duplicate_item_key",
        key: item.key,
      });
    seenKeys.add(sanitized);
    if (item.amount_cents <= 0n)
      throw new LedgerError("GL_SOURCE_INVALID", {
        reason: "non_positive_amount",
        key: item.key,
        amount_cents: item.amount_cents.toString(),
      });
    if (item.kind !== "outstanding_check" && item.kind !== "deposit_in_transit")
      throw new LedgerError("GL_SOURCE_INVALID", {
        reason: "invalid_item_kind",
        key: item.key,
        kind: item.kind,
      });
  }

  const lines: LedgerLine[] = [];

  // Contrapartida neta de `equity`: acumula débitos y créditos por separado,
  // se neta al final en UNA sola línea (Σ debit − Σ credit).
  let equityDebit = 0n;
  let equityCredit = 0n;

  if (balance_cents !== 0n) {
    const magnitude = balance_cents < 0n ? -balance_cents : balance_cents;
    const debitSide = (account.normal_balance === "debit") === balance_cents > 0n;
    if (debitSide) {
      lines.push({
        role: "opening",
        account,
        debit_cents: magnitude,
        credit_cents: 0n,
      });
      equityCredit += magnitude;
    } else {
      lines.push({
        role: "opening",
        account,
        debit_cents: 0n,
        credit_cents: magnitude,
      });
      equityDebit += magnitude;
    }
  }

  for (const item of items) {
    const sanitized = sanitizeKey(item.key);
    if (item.kind === "outstanding_check") {
      lines.push({
        role: `${ROLE_PREFIX}${sanitized}`,
        account,
        debit_cents: 0n,
        credit_cents: item.amount_cents,
        memo: item.description,
      });
      equityDebit += item.amount_cents;
    } else {
      lines.push({
        role: `${ROLE_PREFIX}${sanitized}`,
        account,
        debit_cents: item.amount_cents,
        credit_cents: 0n,
        memo: item.description,
      });
      equityCredit += item.amount_cents;
    }
  }

  if (equityDebit === equityCredit)
    throw new LedgerError("GL_SOURCE_INVALID", { reason: "equity_net_zero" });

  lines.push(
    equityDebit > equityCredit
      ? {
          role: "equity",
          account: equity,
          debit_cents: equityDebit - equityCredit,
          credit_cents: 0n,
        }
      : {
          role: "equity",
          account: equity,
          debit_cents: 0n,
          credit_cents: equityCredit - equityDebit,
        }
  );

  return lines;
}
