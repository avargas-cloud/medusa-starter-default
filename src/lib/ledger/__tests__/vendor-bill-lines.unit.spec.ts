import { buildVendorBillLines } from "../lines/vendor-bill";
import { sanitizeRole } from "../money";
import { account, fakePurchaseAccountMap, sumCredits, sumDebits } from "./fixtures";

describe("buildVendorBillLines", () => {
  const map = fakePurchaseAccountMap();
  const freightExpense = account("FREIGHT-EXP", "Expense", "debit");
  const tariffExpense = account("TARIFF-EXP", "Expense", "debit");

  it("regular bill with receipts at the SAME cost: clears the offset, no variance, no true-up", () => {
    const lines = buildVendorBillLines(
      {
        payableCents: 10_000n,
        offsetCents: 10_000n,
        trueUpCents: 0n,
        expensedLines: [],
        adoptedNoLines: null,
      },
      map
    );
    expect(lines.find((l) => l.role === "inventory_offset")?.debit_cents).toBe(10_000n);
    expect(lines.find((l) => l.role === "inventory_asset")).toBeUndefined();
    expect(lines.find((l) => l.role === "accounts_payable")?.credit_cents).toBe(10_000n);
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });

  it("regular bill billed HIGHER than the receipt cost: the variance capitalizes to inventory_asset", () => {
    const lines = buildVendorBillLines(
      {
        payableCents: 12_000n,
        offsetCents: 10_000n,
        trueUpCents: 0n,
        expensedLines: [],
        adoptedNoLines: null,
      },
      map
    );
    expect(lines.find((l) => l.role === "inventory_offset")?.debit_cents).toBe(10_000n);
    expect(lines.find((l) => l.role === "inventory_asset")?.debit_cents).toBe(2_000n);
    expect(lines.find((l) => l.role === "accounts_payable")?.credit_cents).toBe(12_000n);
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });

  it("regular bill billed LOWER than the receipt cost: inventory_asset takes the credit side", () => {
    const lines = buildVendorBillLines(
      {
        payableCents: 8_000n,
        offsetCents: 10_000n,
        trueUpCents: 0n,
        expensedLines: [],
        adoptedNoLines: null,
      },
      map
    );
    expect(lines.find((l) => l.role === "inventory_asset")?.credit_cents).toBe(2_000n);
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });

  it("true-up (units already sold before the bill) hits cogs_default, not inventory_asset", () => {
    const lines = buildVendorBillLines(
      {
        payableCents: 12_000n,
        offsetCents: 10_000n,
        trueUpCents: 500n,
        expensedLines: [],
        adoptedNoLines: null,
      },
      map
    );
    // variance = 2000, minus the 500 true-up siphoned to cogs_default
    expect(lines.find((l) => l.role === "inventory_asset")?.debit_cents).toBe(1_500n);
    expect(lines.find((l) => l.role === "cogs_default")?.debit_cents).toBe(500n);
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });

  it("sibling bill with a capitalized freight line (in scope=false) and an expensed tariff line (in scope=true)", () => {
    const lines = buildVendorBillLines(
      {
        payableCents: 3_000n,
        offsetCents: 0n,
        trueUpCents: 0n,
        expensedLines: [{ account: tariffExpense, amountCents: 1_000n }],
        adoptedNoLines: null,
      },
      map
    );
    // payable(3000) - offset(0) - expensed(1000) - trueUp(0) = 2000 capitalized
    expect(lines.find((l) => l.role === "inventory_asset")?.debit_cents).toBe(2_000n);
    expect(lines.find((l) => l.role.startsWith("qb_account_"))?.debit_cents).toBe(1_000n);
    expect(lines.find((l) => l.role === "accounts_payable")?.credit_cents).toBe(3_000n);
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });

  it("multiple expensed lines on the SAME account aggregate into one line (unique role)", () => {
    const lines = buildVendorBillLines(
      {
        payableCents: 500n,
        offsetCents: 0n,
        trueUpCents: 0n,
        expensedLines: [
          { account: freightExpense, amountCents: 200n },
          { account: freightExpense, amountCents: 300n },
        ],
        adoptedNoLines: null,
      },
      map
    );
    const freightLines = lines.filter((l) => l.role === sanitizeRole("qb_account", freightExpense.id));
    expect(freightLines).toHaveLength(1);
    expect(freightLines[0]?.debit_cents).toBe(500n);
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });

  it("adopted bill without lines: payable comes from qb_amount_due_cents, straight to inventory_asset/AP", () => {
    const lines = buildVendorBillLines(
      {
        payableCents: 0n,
        offsetCents: 0n,
        trueUpCents: 0n,
        expensedLines: [],
        adoptedNoLines: { qbAmountDueCents: 4_400n },
      },
      map
    );
    expect(lines.find((l) => l.role === "inventory_asset")?.debit_cents).toBe(4_400n);
    expect(lines.find((l) => l.role === "accounts_payable")?.credit_cents).toBe(4_400n);
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });

  it("zero everywhere → no lines (the loader treats this as skipped, never posts an empty document)", () => {
    const lines = buildVendorBillLines(
      { payableCents: 0n, offsetCents: 0n, trueUpCents: 0n, expensedLines: [], adoptedNoLines: null },
      map
    );
    expect(lines).toHaveLength(0);
  });
});
