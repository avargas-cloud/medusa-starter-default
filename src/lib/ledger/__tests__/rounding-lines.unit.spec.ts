import { buildRoundingLines } from "../lines/rounding";
import { LedgerError } from "../types";
import { account, fakeAccountMap, sumCredits, sumDebits } from "./fixtures";

describe("buildRoundingLines", () => {
  const map = fakeAccountMap();
  const rowAccount = account("ROUND-1", "Expense", "debit");

  it("shortage debits the row's account and credits accounts_receivable", () => {
    const lines = buildRoundingLines(
      { amountCents: 3n, direction: "shortage", account: rowAccount },
      map
    );
    expect(lines.find((l) => l.role === "rounding_account")?.debit_cents).toBe(3n);
    expect(lines.find((l) => l.role === "accounts_receivable")?.credit_cents).toBe(3n);
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });

  it("overage debits accounts_receivable and credits the row's account", () => {
    const lines = buildRoundingLines(
      { amountCents: 2n, direction: "overage", account: rowAccount },
      map
    );
    expect(lines.find((l) => l.role === "accounts_receivable")?.debit_cents).toBe(2n);
    expect(lines.find((l) => l.role === "rounding_account")?.credit_cents).toBe(2n);
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });

  it("rejects a non-positive amount", () => {
    expect(() =>
      buildRoundingLines({ amountCents: 0n, direction: "shortage", account: rowAccount }, map)
    ).toThrow(LedgerError);
  });
});
