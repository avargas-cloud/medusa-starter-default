/**
 * src/lib/calendar/occurrence-prefill.ts
 *
 * Lo que un editor de documento necesita para abrirse PRE-LLENADO desde una
 * ocurrencia — resuelto en UN lugar para que CheckEditor, /vendor-bills/new y
 * el "Create & match" del feed no re-deriven cada uno el payee y las cuentas.
 *
 * Sale del SNAPSHOT de la ocurrencia (no de la regla viva) y valida lo que
 * cada documento exige: un bill sin vendor no existe; un check/expense sin
 * cuenta pagadora Bank/CreditCard tampoco; un transfer necesita origen Bank y
 * destino tarjeta / pasivo / banco. Si algo falta, `blocked` lo dice
 * con nombre y la pantalla manda a la regla en vez de a un Save que va a
 * fallar. Nada se escribe.
 */
import type { PoolClient } from "pg";

import { getDbPool } from "../../api/utils/db-pool";

import type { DocumentKind, MatchedKind, PayeeType, RecurringOccurrence, RecurringRule } from "./recurring-types";

export interface PrefillAccount {
  list_id: string;
  name: string;
  account_type: string;
}

export interface OccurrencePrefill {
  occurrence_id: string;
  rule_id: string;
  rule_name: string;
  document_kind: DocumentKind;
  /** Kind que va a resultar en `gl_check` (la cuenta decide: CreditCard → card_charge). */
  check_kind: "check" | "expense" | "card_charge" | null;
  day: string;
  period_key: string;
  amount_cents: number;
  memo: string;
  payee: { type: PayeeType; id: string | null; name: string } | null;
  expense_account: PrefillAccount | null;
  pay_from_account: PrefillAccount | null;
  /** Sólo `transfer`: la cuenta DESTINO (la tarjeta / el pasivo), que la regla guarda en `expense_account_list_id`. */
  to_account: PrefillAccount | null;
  /** Sólo `bill`: el vendor de QB tal como lo espera `/vendor-bills/new`. */
  vendor: { id: string; name: string } | null;
  /** Motivo por el que NO se puede abrir el documento (arreglar la regla). */
  blocked: string | null;
  /** Ya existe uno: la pantalla ofrece abrirlo, no crear otro. */
  existing: { kind: MatchedKind; id: string } | null;
}

type Db = Pick<PoolClient, "query">;

async function loadAccount(db: Db, listId: string | null): Promise<PrefillAccount | null> {
  if (!listId) return null;
  const res = await db.query<PrefillAccount>(
    `SELECT qb_list_id AS list_id, full_name AS name, account_type
       FROM qb_account WHERE qb_list_id = $1 AND is_active AND deleted_at IS NULL`,
    [listId]
  );
  return res.rows[0] ?? null;
}

async function loadVendor(db: Db, id: string | null): Promise<{ id: string; name: string } | null> {
  if (!id) return null;
  const res = await db.query<{ id: string; full_name: string | null; company_name: string | null; name: string | null }>(
    `SELECT id, full_name, company_name, name FROM qb_vendor WHERE id = $1 AND deleted_at IS NULL AND is_active = true`,
    [id]
  );
  const v = res.rows[0];
  return v ? { id: v.id, name: v.company_name || v.full_name || v.name || v.id } : null;
}

/** Memo del documento: nombre de la regla + período, así se lee en el libro y en QB. */
export function prefillMemo(ruleName: string, periodKey: string): string {
  return `${ruleName} — ${periodKey.slice(0, 7)}`;
}

export async function buildOccurrencePrefill(
  occ: RecurringOccurrence,
  rule: Pick<RecurringRule, "id" | "name">,
  db: Db = getDbPool()
): Promise<OccurrencePrefill> {
  const documentKind: DocumentKind = occ.document_kind ?? "expense";
  const [expenseAccount, payFromAccount] = await Promise.all([
    loadAccount(db, occ.expense_account_list_id),
    loadAccount(db, occ.pay_from_account_list_id),
  ]);
  const vendor = documentKind === "bill" && occ.payee_type === "vendor" ? await loadVendor(db, occ.payee_id) : null;

  const TRANSFER_TARGETS = ["CreditCard", "Bank", "OtherCurrentLiability", "LongTermLiability", "OtherCurrentAsset"];
  let blocked: string | null = null;
  if (documentKind === "transfer") {
    if (!payFromAccount) blocked = "The rule has no source bank account (Pay from)";
    else if (payFromAccount.account_type !== "Bank") blocked = `The rule pays from ${payFromAccount.name}, which is not a bank account`;
    else if (!expenseAccount) blocked = "The rule has no destination account (To account)";
    else if (!TRANSFER_TARGETS.includes(expenseAccount.account_type))
      blocked = `${expenseAccount.name} is not a card, loan or bank account`;
  } else if (!expenseAccount) blocked = "The rule has no expense account";
  else if (documentKind === "bill") {
    if (occ.payee_type !== "vendor" || !occ.payee_id) blocked = "A bill needs a vendor payee on the rule";
    else if (!vendor) blocked = "The rule's vendor is inactive or was deleted";
  } else {
    if (!payFromAccount) blocked = "The rule has no bank or card account to pay from";
    else if (!["Bank", "CreditCard"].includes(payFromAccount.account_type))
      blocked = `The rule pays from ${payFromAccount.name}, which is not a bank or card account`;
    else if (!occ.payee_name) blocked = "The rule has no payee";
  }

  const checkKind =
    documentKind === "bill" || documentKind === "transfer" || !payFromAccount
      ? null
      : payFromAccount.account_type === "CreditCard"
        ? "card_charge"
        : documentKind;

  return {
    occurrence_id: occ.id,
    rule_id: rule.id,
    rule_name: rule.name,
    document_kind: documentKind,
    check_kind: checkKind,
    day: occ.due_date,
    period_key: occ.period_key,
    amount_cents: occ.expected_amount_cents,
    memo: prefillMemo(rule.name, occ.period_key),
    payee: occ.payee_name ? { type: occ.payee_type ?? "other", id: occ.payee_id, name: occ.payee_name } : null,
    expense_account: documentKind === "transfer" ? null : expenseAccount,
    pay_from_account: payFromAccount,
    to_account: documentKind === "transfer" ? expenseAccount : null,
    vendor,
    blocked,
    existing: occ.matched_kind && occ.matched_id ? { kind: occ.matched_kind, id: occ.matched_id } : null,
  };
}
