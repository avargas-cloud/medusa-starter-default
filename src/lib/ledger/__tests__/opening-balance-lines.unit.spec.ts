import { buildOpeningBalanceLines } from "../lines/opening-balance";
import { LedgerError } from "../types";
import { account, sumCredits, sumDebits } from "./fixtures";

describe("buildOpeningBalanceLines", () => {
  const equity = account("OBE-1", "Equity", "credit");

  it("an asset (debit-normal) account debits `opening`, credits `equity`", () => {
    const ar = account("AR-1", "AccountsReceivable", "debit");
    const lines = buildOpeningBalanceLines({
      account: ar,
      balance_cents: 10_000n,
      items: [],
      equity,
    });
    expect(lines.find((l) => l.role === "opening")?.debit_cents).toBe(10_000n);
    expect(lines.find((l) => l.role === "equity")?.credit_cents).toBe(10_000n);
    expect(sumDebits(lines)).toBe(sumCredits(lines));
    expect(lines).toHaveLength(2);
  });

  it("a liability (credit-normal) account credits `opening`, debits `equity`", () => {
    const ap = account("AP-1", "AccountsPayable", "credit");
    const lines = buildOpeningBalanceLines({
      account: ap,
      balance_cents: 5_000n,
      items: [],
      equity,
    });
    expect(lines.find((l) => l.role === "opening")?.credit_cents).toBe(5_000n);
    expect(lines.find((l) => l.role === "equity")?.debit_cents).toBe(5_000n);
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });

  it("a NEGATIVE balance on a debit-normal account (contra asset) credits `opening`, debits `equity`", () => {
    const depreciation = account("FA-DEP", "FixedAsset", "debit");
    const lines = buildOpeningBalanceLines({
      account: depreciation,
      balance_cents: -9_530_471n,
      items: [],
      equity,
    });
    expect(lines.find((l) => l.role === "opening")?.credit_cents).toBe(9_530_471n);
    expect(lines.find((l) => l.role === "opening")?.debit_cents).toBe(0n);
    expect(lines.find((l) => l.role === "equity")?.debit_cents).toBe(9_530_471n);
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });

  it("a NEGATIVE balance on a credit-normal account (AP with a debit balance) debits `opening`", () => {
    const ap = account("AP-1", "AccountsPayable", "credit");
    const lines = buildOpeningBalanceLines({
      account: ap,
      balance_cents: -2_224_572n,
      items: [],
      equity,
    });
    expect(lines.find((l) => l.role === "opening")?.debit_cents).toBe(2_224_572n);
    expect(lines.find((l) => l.role === "equity")?.credit_cents).toBe(2_224_572n);
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });

  it("rejects a negative balance together with items", () => {
    const bank = account("BANK-1", "Bank", "debit");
    expect(() =>
      buildOpeningBalanceLines({
        account: bank,
        balance_cents: -100n,
        items: [{ key: "chk-1", kind: "outstanding_check", amount_cents: 50n, description: "x" }],
        equity,
      })
    ).toThrow(LedgerError);
  });

  it("Bank with an outstanding check and a deposit in transit nets a single `equity` line", () => {
    const bank = account("BANK-1", "Bank", "debit");
    const lines = buildOpeningBalanceLines({
      account: bank,
      balance_cents: 10_000n,
      items: [
        {
          key: "chk-1042",
          kind: "outstanding_check",
          original_day: "2026-04-01",
          amount_cents: 1_000n,
          reference: "1042",
        },
        {
          key: "dep-9",
          kind: "deposit_in_transit",
          original_day: "2026-04-10",
          amount_cents: 400n,
          reference: "dep-9",
        },
      ],
      equity,
    });

    // opening: Dr 10000 · uncleared_chk_1042: Cr 1000 · uncleared_dep_9: Dr 400
    // equity counterparts: Cr(opening) 10000 + Dr(check) 1000 + Cr(deposit) 400
    //   => equityDebit=1000, equityCredit=10400 => net Cr 9400
    const equityLine = lines.find((l) => l.role === "equity");
    expect(equityLine?.credit_cents).toBe(9_400n);
    expect(equityLine?.debit_cents).toBe(0n);
    expect(lines.filter((l) => l.role.startsWith("uncleared_"))).toHaveLength(2);
    expect(lines).toHaveLength(4); // opening + 2 items + equity
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });

  it("rejects items on a non-Bank account", () => {
    const ar = account("AR-1", "AccountsReceivable", "debit");
    expect(() =>
      buildOpeningBalanceLines({
        account: ar,
        balance_cents: 1_000n,
        items: [
          {
            key: "chk-1",
            kind: "outstanding_check",
            original_day: "2026-04-01",
            amount_cents: 100n,
            reference: "1",
          },
        ],
        equity,
      })
    ).toThrow(LedgerError);
  });

  it("rejects duplicate item keys", () => {
    const bank = account("BANK-1", "Bank", "debit");
    expect(() =>
      buildOpeningBalanceLines({
        account: bank,
        balance_cents: 1_000n,
        items: [
          {
            key: "chk-1",
            kind: "outstanding_check",
            original_day: "2026-04-01",
            amount_cents: 100n,
            reference: "1",
          },
          {
            key: "chk-1",
            kind: "outstanding_check",
            original_day: "2026-04-02",
            amount_cents: 200n,
            reference: "1b",
          },
        ],
        equity,
      })
    ).toThrow(LedgerError);
  });

  it("rejects a non-positive item amount", () => {
    const bank = account("BANK-1", "Bank", "debit");
    expect(() =>
      buildOpeningBalanceLines({
        account: bank,
        balance_cents: 1_000n,
        items: [
          {
            key: "chk-1",
            kind: "outstanding_check",
            original_day: "2026-04-01",
            amount_cents: 0n,
            reference: "1",
          },
        ],
        equity,
      })
    ).toThrow(LedgerError);
  });

  it("rejects balance 0 with no items", () => {
    const ar = account("AR-1", "AccountsReceivable", "debit");
    expect(() =>
      buildOpeningBalanceLines({ account: ar, balance_cents: 0n, items: [], equity })
    ).toThrow(LedgerError);
  });

  it("a Bank with balance 0 and items skips the `opening` line", () => {
    const bank = account("BANK-1", "Bank", "debit");
    const lines = buildOpeningBalanceLines({
      account: bank,
      balance_cents: 0n,
      items: [
        {
          key: "dep-1",
          kind: "deposit_in_transit",
          original_day: "2026-04-01",
          amount_cents: 500n,
          reference: "dep-1",
        },
      ],
      equity,
    });
    expect(lines.find((l) => l.role === "opening")).toBeUndefined();
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });
});
