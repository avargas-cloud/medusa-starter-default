/**
 * src/lib/calendar/feed-expected-hints.ts
 *
 * "Expected" hint del Bank Feed: para una línea de SALIDA del banco, las
 * ocurrencias del Accounting Calendar que podrían ser — misma cuenta pagadora,
 * monto dentro de la tolerancia, fecha a ≤ N días. Se calcula EN LECTURA (como
 * la `category` de las reglas), no en el motor de sugerencias: no es un
 * candidato del LIBRO, es una expectativa sin documento todavía; por eso no
 * mueve `SUGGEST_ENGINE_VERSION` ni se persiste. El payee entra al ORDEN, no
 * al filtro (los nombres de Plaid son ruidosos).
 *
 * Una regla sin cuenta pagadora no sugiere nada: sin ese filtro la misma renta
 * aparecería en todos los bancos.
 */
import { getDbPool } from "../../api/utils/db-pool";

import { OCCURRENCE_COLS, rowToOccurrence } from "./recurring-repo";
import type { DocumentKind, MatchedKind, PayeeType, RecurringOccurrence } from "./recurring-types";

export const EXPECTED_HINT_DAYS = 7;
const MAX_HINTS_PER_LINE = 3;

export type FeedExpectedHint = {
  occurrence_id: string;
  rule_id: string;
  rule_name: string;
  due_date: string;
  expected_amount_cents: number;
  document_kind: DocumentKind;
  payee_type: PayeeType | null;
  payee_id: string | null;
  payee_name: string | null;
  expense_account: { list_id: string; name: string } | null;
  status: "expected" | "booked";
  /** Un documento ya nacido de esta ocurrencia (draft sin postear, típicamente). */
  existing_document: { kind: MatchedKind; id: string; doc_number: string; status: string } | null;
  day_distance: number;
  amount_delta_cents: number;
  payee_match: boolean;
  /** Va en el preview hash del Create & match: si la ocurrencia cambió, 409. */
  updated_at: string;
};

type Row = {
  transaction_id: string;
  tx_name: string;
  merchant_name: string | null;
  occurrence_id: string;
  rule_id: string;
  rule_name: string;
  due_date: string;
  expected_amount_cents: string;
  document_kind: string | null;
  payee_type: string | null;
  payee_id: string | null;
  payee_name: string | null;
  expense_account_list_id: string | null;
  expense_account_name: string | null;
  status: string;
  matched_kind: string | null;
  matched_id: string | null;
  doc_number: string | null;
  doc_status: string | null;
  updated_at: string;
  day_distance: string;
  amount_delta: string;
};

const STOP = new Set(["the", "inc", "llc", "co", "corp", "of", "and", "de", "la", "el", "ltd"]);
function tokens(s: string | null): Set<string> {
  return new Set(
    (s ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !STOP.has(t))
  );
}

/** Coincidencia de payee: al menos un token significativo en común con el nombre del banco. */
export function payeeMatches(payee: string | null, txName: string, merchant: string | null): boolean {
  const p = tokens(payee);
  if (!p.size) return false;
  const bank = new Set([...tokens(txName), ...tokens(merchant)]);
  for (const t of p) if (bank.has(t)) return true;
  return false;
}

/** Hints por transacción del feed. Sólo salidas (`amount > 0` en Plaid; la columna es TEXT). */
export async function expectedHintsByTransaction(
  transactionIds: string[]
): Promise<Map<string, FeedExpectedHint[]>> {
  const out = new Map<string, FeedExpectedHint[]>();
  if (!transactionIds.length) return out;
  const rows = (
    await getDbPool().query<Row>(
      `SELECT t.id AS transaction_id, t.name AS tx_name, t.merchant_name,
              o.id AS occurrence_id, r.id AS rule_id, r.name AS rule_name, o.due_date::text AS due_date,
              o.expected_amount_cents::text AS expected_amount_cents, o.document_kind, o.payee_type, o.payee_id, o.payee_name,
              o.expense_account_list_id, qa.full_name AS expense_account_name, o.status, o.matched_kind, o.matched_id,
              gc.doc_number, gc.status AS doc_status, o.updated_at::text AS updated_at,
              abs(o.due_date - t.transaction_date::date)::text AS day_distance,
              abs(round(t.amount::numeric * 100) - o.expected_amount_cents)::text AS amount_delta
         FROM bank_transaction t
         JOIN bank_account a ON a.id = t.account_id AND a.deleted_at IS NULL
         JOIN recurring_expense_occurrence o
           ON o.pay_from_account_list_id = a.qb_list_id
          AND o.status IN ('expected', 'booked')
          AND abs(o.due_date - t.transaction_date::date) <= $2
          AND abs(round(t.amount::numeric * 100) - o.expected_amount_cents)
              <= GREATEST(o.tolerance_cents, round(o.expected_amount_cents * o.tolerance_pct / 100))
         JOIN recurring_expense_rule r ON r.id = o.rule_id
         LEFT JOIN qb_account qa ON qa.qb_list_id = o.expense_account_list_id AND qa.deleted_at IS NULL
         LEFT JOIN gl_check gc ON o.matched_kind = 'gl_check' AND gc.id = o.matched_id AND gc.deleted_at IS NULL
        WHERE t.id = ANY($1::text[]) AND t.deleted_at IS NULL AND t.amount::numeric > 0
        ORDER BY t.id, o.due_date, o.id`,
      [transactionIds, EXPECTED_HINT_DAYS]
    )
  ).rows;
  for (const r of rows) {
    const hint: FeedExpectedHint = {
      occurrence_id: r.occurrence_id,
      rule_id: r.rule_id,
      rule_name: r.rule_name,
      due_date: r.due_date,
      expected_amount_cents: Number(r.expected_amount_cents),
      document_kind: (r.document_kind ?? "expense") as DocumentKind,
      payee_type: r.payee_type as PayeeType | null,
      payee_id: r.payee_id,
      payee_name: r.payee_name,
      expense_account: r.expense_account_list_id
        ? { list_id: r.expense_account_list_id, name: r.expense_account_name ?? r.expense_account_list_id }
        : null,
      status: r.status as "expected" | "booked",
      existing_document:
        r.matched_kind && r.matched_id
          ? { kind: r.matched_kind as MatchedKind, id: r.matched_id, doc_number: r.doc_number ?? r.matched_id, status: r.doc_status ?? "unknown" }
          : null,
      day_distance: Number(r.day_distance),
      amount_delta_cents: Number(r.amount_delta),
      payee_match: payeeMatches(r.payee_name, r.tx_name, r.merchant_name),
      updated_at: r.updated_at,
    };
    const list = out.get(r.transaction_id) ?? [];
    list.push(hint);
    out.set(r.transaction_id, list);
  }
  for (const [id, list] of out) {
    list.sort(
      (a, b) =>
        Number(b.payee_match) - Number(a.payee_match) ||
        a.day_distance - b.day_distance ||
        a.amount_delta_cents - b.amount_delta_cents
    );
    out.set(id, list.slice(0, MAX_HINTS_PER_LINE));
  }
  return out;
}

/** La ocurrencia que un "Create & match" del feed quiere liquidar, leída por el pool `$n`. */
export async function loadOccurrenceForFeed(id: string): Promise<RecurringOccurrence | null> {
  const res = await getDbPool().query<Record<string, unknown>>(
    `SELECT ${OCCURRENCE_COLS} FROM recurring_expense_occurrence WHERE id = $1`,
    [id]
  );
  return res.rows[0] ? rowToOccurrence(res.rows[0]) : null;
}
