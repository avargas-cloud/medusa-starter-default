import {
  planReclassification,
  RECLASSIFY_CONTEXT_SQL,
  reclassifySchema,
  type ReclassifyContext,
} from "../../lib/banking/reclassification";

/**
 * Regla 3 de docs/POLITICA_CORRECCIONES_CONTABLES.md: extracto cerrado, mismo monto,
 * cuenta equivocada → JE de reclasificación en el mes abierto (Dr correcta / Cr
 * equivocada); el banco no se toca. El planner es puro: la matriz de rechazos vive
 * acá; que la orquestación deje CERO filas al rechazar lo prueba el E2E del sandbox.
 */
const target = { id: "acct_office", name: "Office Supplies", account_type: "Expense", currency: "USD" as const, normal_balance: "debit" as const };
const bankTarget = { ...target, id: "acct_chk", name: "Checking", account_type: "Bank" };
function ctx(over: Partial<ReclassifyContext> = {}): ReclassifyContext {
  return {
    match_id: "bsm_1",
    statement_status: "closed",
    entry_id: "bje_1",
    entry_reference: "CHK-0109",
    payee_name: "Mailchimp",
    counter: {
      line_id: "bjl_c",
      account_list_id: "acct_dues",
      account_name: "Dues and Subscriptions",
      account_type: "Expense",
      debit_cents: 2650,
      credit_cents: 0,
      reclassified_cents: 0,
    },
    ...over,
  };
}
const input = { match_id: "bsm_1", counter_line_id: "bjl_c", to_account_list_id: "acct_office", amount_cents: 2650, day: "2026-09-15" };

describe("planReclassification", () => {
  it("expense debited wrong → Dr correct / Cr wrong for the amount, memo names the document and payee", () => {
    const plan = planReclassification(ctx(), input, target);
    expect(plan).toEqual({
      day: "2026-09-15",
      memo: "Reclassification · CHK-0109 · Mailchimp",
      lines: [
        { account_list_id: "acct_office", debit_cents: 2650n, credit_cents: 0n, memo: "Reclassification · CHK-0109 · Mailchimp" },
        { account_list_id: "acct_dues", debit_cents: 0n, credit_cents: 2650n, memo: "Reclassification · CHK-0109 · Mailchimp" },
      ],
    });
  });
  it("a CREDITED counter line (income / UF) reclassifies the other way round", () => {
    const plan = planReclassification(
      ctx({ counter: { ...ctx().counter!, debit_cents: 0, credit_cents: 888063 } }),
      { ...input, amount_cents: 100 },
      target
    );
    expect(plan.lines.map((l) => [l.account_list_id, l.debit_cents, l.credit_cents])).toEqual([
      ["acct_dues", 100n, 0n],
      ["acct_office", 0n, 100n],
    ]);
  });
  it("partial: the cap is the counter line minus what posted reclassifications already moved", () => {
    const c = ctx({ counter: { ...ctx().counter!, reclassified_cents: 2000 } });
    expect(planReclassification(c, { ...input, amount_cents: 650 }, target).lines[0]!.debit_cents).toBe(650n);
    expect(() => planReclassification(c, { ...input, amount_cents: 651 }, target)).toThrow(
      expect.objectContaining({ code: "GL_SOURCE_INVALID", details: { reason: "amount_exceeds_reclassifiable", reclassifiable_cents: 650 } })
    );
  });
  it.each([
    ["statement still draft → unmatch instead", ctx({ statement_status: "draft" }), input, target, "statement_not_closed"],
    ["counter line does not belong to the entry", ctx({ counter: null }), input, target, "counter_line_not_in_entry"],
    ["counter line is the bank side", ctx({ counter: { ...ctx().counter!, account_type: "CreditCard" } }), input, target, "counter_line_is_bank"],
    ["target account is a bank / card", ctx(), input, bankTarget, "target_account_is_bank"],
    ["target equals the current account", ctx(), { ...input, to_account_list_id: "acct_dues" }, { ...target, id: "acct_dues" }, "same_account"],
    ["2025 is declared: nothing is dated there", ctx(), { ...input, day: "2025-12-31" }, target, "day_before_2026"],
    ["amount must be positive", ctx(), { ...input, amount_cents: 0 }, target, "amount_exceeds_reclassifiable"],
  ])("rejects: %s", (_name, c, i, t, reason) => {
    expect(() => planReclassification(c as ReclassifyContext, i, t)).toThrow(
      expect.objectContaining({ code: "GL_SOURCE_INVALID", details: expect.objectContaining({ reason }) })
    );
  });
  it("memo from the caller wins over the default", () => {
    expect(planReclassification(ctx(), { ...input, memo: "  Software, not dues " }, target).memo).toBe("Software, not dues");
  });
});

describe("reclassifySchema", () => {
  it("accepts the minimal body and rejects a non-integer or negative amount", () => {
    expect(reclassifySchema.safeParse({ match_id: "bsm_1", counter_line_id: "bjl_c", to_account_list_id: "a", amount_cents: 1 }).success).toBe(true);
    expect(reclassifySchema.safeParse({ match_id: "bsm_1", counter_line_id: "bjl_c", to_account_list_id: "a", amount_cents: 1.5 }).success).toBe(false);
    expect(reclassifySchema.safeParse({ match_id: "bsm_1", counter_line_id: "bjl_c", to_account_list_id: "a", amount_cents: -1 }).success).toBe(false);
    expect(reclassifySchema.safeParse({ match_id: "bsm_1", counter_line_id: "bjl_c", to_account_list_id: "a", amount_cents: 1, day: "15/09/2026" }).success).toBe(false);
  });
});

describe("RECLASSIFY_CONTEXT_SQL", () => {
  it("resolves the match → statement status, the entry and ONLY that entry's counter line, with posted reclassifications summed", () => {
    expect(RECLASSIFY_CONTEXT_SQL).toMatch(/FROM bank_statement_match m/);
    expect(RECLASSIFY_CONTEXT_SQL).toMatch(/JOIN bank_statement st ON st\.id=sl\.statement_id/);
    expect(RECLASSIFY_CONTEXT_SQL).toMatch(/LEFT JOIN bank_journal_line c ON c\.id=\$2 AND c\.entry_id=e\.id AND c\.deleted_at IS NULL/);
    expect(RECLASSIFY_CONTEXT_SQL).toMatch(/j\.corrects_line_id=c\.id AND j\.status='posted' AND j\.deleted_at IS NULL/);
    expect(RECLASSIFY_CONTEXT_SQL).toMatch(/m\.id=\$1 AND m\.deleted_at IS NULL/);
  });
});
