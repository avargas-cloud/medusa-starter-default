import type { PoolClient } from "pg";

import {
  CORRECTIONS_SQL,
  COUNTER_LINES_SQL,
  RECONCILED_MATCHES_SQL,
  reconciledMatchesProjection,
  type ReconciledMatchRow,
} from "../../lib/banking/reconciled-matches";

/**
 * Filas Reconciled del Bank Feed: cada una muestra los asientos del libro con los que
 * casó por extracto (2026-09-15). El post-pass corre UNA query por página con los ids
 * reconciled y cuelga `reconciled.matches` — nunca en filas sin `reconciled`.
 *
 * El mock devuelve las filas tal como saldrían del SQL (ya firmadas y resueltas), así
 * que acá se prueba el REPARTO por transacción, el orden, el filtro de entrada y la
 * forma del contrato. Que el SQL bindee y firme bien lo prueba /sql-bindcheck y el
 * E2E del sandbox (btxn_0230b317…: 2 depósitos − 2 cheques = 8,636.35).
 */
const reconciled = {
  statement_id: "bst_1",
  from_day: "2026-08-01",
  to_day: "2026-08-31",
};
function sqlRow(over: Partial<ReconciledMatchRow>): ReconciledMatchRow {
  return {
    match_id: "bsm_x",
    transaction_id: "btxn_a",
    statement_line_id: "bsl_a",
    line_id: "bjl_x",
    entry_id: "bje_x",
    day: "2026-08-25",
    source_kind: "qb_import",
    source_id: "1CE132-1787662179",
    document_number: "Deposit 1CE132-1787662179",
    payee_name: null,
    memo: "Deposit",
    amount_cents: 888063,
    is_reversal: false,
    is_reversed: false,
    ...over,
  };
}
// El depósito neto de tarjeta del sandbox + una fila de cheque de OTRA transacción.
const dbRows: ReconciledMatchRow[] = [
  sqlRow({ match_id: "bsm_1", line_id: "bjl_1", entry_id: "bje_1" }),
  sqlRow({
    match_id: "bsm_2", line_id: "bjl_2", entry_id: "bje_2",
    source_id: "1CE18A-1787665316", document_number: "Deposit 1CE18A-1787665316", amount_cents: 10618,
  }),
  sqlRow({
    match_id: "bsm_3", line_id: "bjl_3", entry_id: "bje_3", day: "2026-08-24",
    source_id: "1CDF1D-1787584369", document_number: "Check 1CDF1D-1787584369", payee_name: "Card refund", amount_cents: -20046,
  }),
  sqlRow({
    match_id: "bsm_4", line_id: "bjl_4", entry_id: "bje_4",
    source_id: "1CE173-1787664239", document_number: "Check 1CE173-1787664239", amount_cents: -15000,
  }),
  sqlRow({
    match_id: "bsm_9", transaction_id: "btxn_b", statement_line_id: "bsl_b", line_id: "bjl_9", entry_id: "bje_9",
    source_kind: "bank_check", source_id: "glc_01", document_number: "CHK-0002", payee_name: "Legrand",
    memo: "Check", amount_cents: -253039,
  }),
];

// Contralíneas de los asientos (lo que una reclasificación mueve) y JEs que ya corrigieron un match.
const counterRows = [
  { line_id: "bjl_9c", entry_id: "bje_9", account_list_id: "acct_exp", account_name: "Dues and Subscriptions",
    account_type: "Expense", debit_cents: "253039", credit_cents: "0", reclassified_cents: "10000" },
  { line_id: "bjl_1c", entry_id: "bje_1", account_list_id: "acct_uf", account_name: "Undeposited Funds",
    account_type: "OtherCurrentAsset", debit_cents: "0", credit_cents: "888063", reclassified_cents: "0" },
];
const correctionRows = [
  { journal_entry_id: "gje_1", number: "JE-0021", day: "2026-09-15", corrects_match_id: "bsm_9", amount_cents: "10000" },
];

function fakeClient(rows: ReconciledMatchRow[]) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      const ids = (params?.[0] as string[]) ?? [];
      if (sql === COUNTER_LINES_SQL) return { rows: counterRows.filter((r) => ids.includes(r.entry_id)) };
      if (sql === CORRECTIONS_SQL) return { rows: correctionRows.filter((r) => ids.includes(r.corrects_match_id)) };
      return { rows: rows.filter((r) => ids.includes(r.transaction_id)) };
    },
  } as unknown as Pick<PoolClient, "query">;
  return { client, calls };
}

describe("reconciledMatchesProjection", () => {
  it("attaches every matched entry to ITS transaction, signed, with the stable order day/entry/match", async () => {
    const { client, calls } = fakeClient(dbRows);
    const out = await reconciledMatchesProjection(client, [
      { id: "btxn_a", reconciled },
      { id: "btxn_b", reconciled },
    ]);
    // 3 queries per page: matches, then their counter lines and their corrections
    expect(calls.map((c) => c.sql)).toEqual([RECONCILED_MATCHES_SQL, COUNTER_LINES_SQL, CORRECTIONS_SQL]);
    expect(calls[0]!.params[0]).toEqual(["btxn_a", "btxn_b"]);
    expect(calls[1]!.params[0]).toEqual(["bje_1", "bje_2", "bje_3", "bje_4", "bje_9"]);
    expect(calls[2]!.params[0]).toEqual(["bsm_1", "bsm_2", "bsm_3", "bsm_4", "bsm_9"]);
    const a = out[0]!.reconciled!.matches;
    expect(a.map((m) => m.match_id)).toEqual(["bsm_1", "bsm_2", "bsm_3", "bsm_4"]);
    expect(a.reduce((sum, m) => sum + m.amount_cents, 0)).toBe(863635);
    expect(a[0]).toMatchObject({
      match_id: "bsm_1", statement_line_id: "bsl_a", line_id: "bjl_1", entry_id: "bje_1",
      source_kind: "qb_import", source_id: "1CE132-1787662179", doc_label: "Deposit 1CE132-1787662179",
      payee_name: null, memo: "Deposit", amount_cents: 888063, is_reversal: false, is_reversed: false,
    });
    const b = out[1]!.reconciled!.matches;
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ match_id: "bsm_9", doc_label: "Check CHK-0002", payee_name: "Legrand", amount_cents: -253039 });
    // counter lines ride on the ENTRY (coerced numbers); corrections on the MATCH
    expect(b[0]!.counter_lines).toEqual([
      { line_id: "bjl_9c", account_list_id: "acct_exp", account_name: "Dues and Subscriptions", account_type: "Expense",
        debit_cents: 253039, credit_cents: 0, reclassified_cents: 10000 },
    ]);
    expect(b[0]!.corrections).toEqual([{ journal_entry_id: "gje_1", number: "JE-0021", day: "2026-09-15", amount_cents: 10000 }]);
    expect(a[0]!.counter_lines.map((l) => l.line_id)).toEqual(["bjl_1c"]);
    expect(a[1]!.counter_lines).toEqual([]);
    expect(a[0]!.corrections).toEqual([]);
    // los campos de la página no se pierden
    expect(out[0]!.reconciled).toMatchObject(reconciled);
  });

  it("never attaches matches to a row that is not reconciled, and skips the query when no row is", async () => {
    const { client, calls } = fakeClient(dbRows);
    const out = await reconciledMatchesProjection(client, [
      { id: "btxn_a", reconciled: null },
      { id: "btxn_c" },
    ]);
    expect(calls).toHaveLength(0);
    expect(out[0]).toEqual({ id: "btxn_a", reconciled: null });
    expect(out[1]).toEqual({ id: "btxn_c" });
  });

  it("queries only the reconciled ids of the page", async () => {
    const { client, calls } = fakeClient(dbRows);
    const out = await reconciledMatchesProjection(client, [
      { id: "btxn_a", reconciled: null },
      { id: "btxn_b", reconciled },
    ]);
    expect(calls[0]!.params[0]).toEqual(["btxn_b"]);
    expect(out[0]).toEqual({ id: "btxn_a", reconciled: null });
    expect(out[1]!.reconciled!.matches.map((m) => m.match_id)).toEqual(["bsm_9"]);
  });

  it("a reconciled row whose matches were removed keeps an empty list, not undefined — and skips the follow-up queries", async () => {
    const { client, calls } = fakeClient([]);
    const out = await reconciledMatchesProjection(client, [{ id: "btxn_a", reconciled }]);
    expect(out[0]!.reconciled!.matches).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("keeps a reversal and its original as two signed entries with unambiguous flags", async () => {
    const { client } = fakeClient([
      sqlRow({ match_id: "bsm_o", entry_id: "bje_o", source_kind: "journal_entry", document_number: "JE-0016", amount_cents: 24, is_reversed: true }),
      sqlRow({ match_id: "bsm_r", entry_id: "bje_r", source_kind: "reversal", document_number: null, amount_cents: -24, is_reversal: true }),
    ]);
    const [row] = await reconciledMatchesProjection(client, [{ id: "btxn_a", reconciled }]);
    expect(row!.reconciled!.matches.map((m) => [m.doc_label, m.amount_cents, m.is_reversal, m.is_reversed])).toEqual([
      ["Journal JE-0016", 24, false, true],
      ["Reversal", -24, true, false],
    ]);
  });

  it("coerces the numeric text pg returns for bigint arithmetic", async () => {
    const { client } = fakeClient([sqlRow({ amount_cents: "-15000" as unknown as number })]);
    const [row] = await reconciledMatchesProjection(client, [{ id: "btxn_a", reconciled }]);
    expect(row!.reconciled!.matches[0]!.amount_cents).toBe(-15000);
  });
});

describe("RECONCILED_MATCHES_SQL", () => {
  it("joins the statement line, the journal line and its entry, filters soft-deletes and signs by the line", () => {
    expect(RECONCILED_MATCHES_SQL).toMatch(/FROM bank_statement_match m/);
    expect(RECONCILED_MATCHES_SQL).toMatch(/JOIN bank_statement_line sl ON sl\.id=m\.statement_line_id AND sl\.deleted_at IS NULL/);
    expect(RECONCILED_MATCHES_SQL).toMatch(/JOIN bank_journal_line l ON l\.id=m\.book_id AND l\.deleted_at IS NULL/);
    expect(RECONCILED_MATCHES_SQL).toMatch(/JOIN bank_journal_entry e ON e\.id=l\.entry_id AND e\.deleted_at IS NULL/);
    expect(RECONCILED_MATCHES_SQL).toMatch(/SIGN\(l\.debit_cents-l\.credit_cents\)\*m\.amount_cents/);
    expect(RECONCILED_MATCHES_SQL).toMatch(/m\.deleted_at IS NULL AND m\.book_kind='journal_line'/);
    expect(RECONCILED_MATCHES_SQL).toMatch(/sl\.transaction_id=ANY\(\$1::text\[\]\)/);
    // payee: la misma resolución que el register (qb_import → source_snapshot.name, gl_check → payee_name)
    expect(RECONCILED_MATCHES_SQL).toMatch(/LEFT JOIN gl_check gc ON/);
    expect(RECONCILED_MATCHES_SQL).toMatch(/source_snapshot->>'name'/);
    expect(RECONCILED_MATCHES_SQL).toMatch(/ORDER BY e\.day,e\.id,m\.id/);
  });
  it("counter lines exclude the bank side and count only POSTED reclassifications; corrections only POSTED JEs", () => {
    expect(COUNTER_LINES_SQL).toMatch(/NOT IN \('Bank','CreditCard'\)/);
    expect(COUNTER_LINES_SQL).toMatch(/j\.corrects_line_id=l\.id AND j\.status='posted' AND j\.deleted_at IS NULL/);
    expect(CORRECTIONS_SQL).toMatch(/j\.corrects_match_id=ANY\(\$1::text\[\]\) AND j\.status='posted' AND j\.deleted_at IS NULL/);
  });
});
