import { buildJournalEntryLines } from "../../lib/ledger/lines/journal-entry";
import { LedgerError } from "../../lib/ledger/types";
import { account, sumCredits, sumDebits } from "./fixtures";

describe("buildJournalEntryLines", () => {
  const cash = account("BANK-1", "Bank", "debit");
  const rent = account("EXP-1", "Expense", "debit");

  it("balanced 2-line entry: roles line_1/line_2, sides as given, memo kept", () => {
    const lines = buildJournalEntryLines([
      { account: rent, debit_cents: 1_234n, credit_cents: 0n, memo: "rent" },
      { account: cash, debit_cents: 0n, credit_cents: 1_234n },
    ]);
    expect(lines.map((l) => l.role)).toEqual(["line_1", "line_2"]);
    expect(lines[0]).toMatchObject({ account: rent, debit_cents: 1_234n, credit_cents: 0n, memo: "rent" });
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });

  it("unbalanced → GL_UNBALANCED_DOCUMENT", () => {
    expect(() =>
      buildJournalEntryLines([
        { account: rent, debit_cents: 100n, credit_cents: 0n },
        { account: cash, debit_cents: 0n, credit_cents: 99n },
      ])
    ).toThrow(expect.objectContaining({ code: "GL_UNBALANCED_DOCUMENT" }));
  });

  it("all-zero lines → GL_SOURCE_INVALID (a line must have exactly one side)", () => {
    expect(() =>
      buildJournalEntryLines([
        { account: rent, debit_cents: 0n, credit_cents: 0n },
        { account: cash, debit_cents: 0n, credit_cents: 0n },
      ])
    ).toThrow(expect.objectContaining({ code: "GL_SOURCE_INVALID" }));
  });

  it("both sides on one line → GL_SOURCE_INVALID", () => {
    expect(() =>
      buildJournalEntryLines([
        { account: rent, debit_cents: 5n, credit_cents: 5n },
        { account: cash, debit_cents: 0n, credit_cents: 0n },
      ])
    ).toThrow(LedgerError);
  });

  it("fewer than 2 or more than 200 lines → GL_SOURCE_INVALID line_count", () => {
    expect(() => buildJournalEntryLines([{ account: rent, debit_cents: 1n, credit_cents: 0n }])).toThrow(
      expect.objectContaining({ code: "GL_SOURCE_INVALID", details: expect.objectContaining({ reason: "line_count" }) })
    );
    const many = Array.from({ length: 201 }, (_, i) =>
      i % 2 === 0
        ? { account: rent, debit_cents: 1n, credit_cents: 0n }
        : { account: cash, debit_cents: 0n, credit_cents: 1n }
    );
    expect(() => buildJournalEntryLines(many)).toThrow(LedgerError);
  });

  it("NonPosting account is rejected", () => {
    expect(() =>
      buildJournalEntryLines([
        { account: account("NP-1", "NonPosting"), debit_cents: 1n, credit_cents: 0n },
        { account: cash, debit_cents: 0n, credit_cents: 1n },
      ])
    ).toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: "non_posting_account" }) }));
  });
});
