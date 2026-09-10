import { buildCreditMemoLines, buildFraudWriteoffLines } from "../lines/credit-memo";
import { CreditMemoSnapshot, LedgerError } from "../types";
import { fakeAccountMap, sumCredits, sumDebits } from "./fixtures";

describe("buildCreditMemoLines", () => {
  const map = fakeAccountMap();

  it("balances a plain return (no damaged units, subtotal is gross)", () => {
    const snapshot: CreditMemoSnapshot = {
      totalCents: 10000n,
      subtotalCents: 10000n,
      discountCents: 0n,
      shippingCents: 0n,
      taxCents: 0n,
      isFraudWriteoff: false,
      lines: [
        {
          quantity: 2,
          damagedQty: 0,
          lineTotalCents: 10000n,
          unitCostDollars: "20.00",
          incomeAccount: map.income_default,
          cogsAccount: map.cogs_default,
        },
      ],
    };
    const lines = buildCreditMemoLines(snapshot, map);
    expect(sumDebits(lines)).toBe(sumCredits(lines));
    expect(lines.find((l) => l.role === "income_0")?.debit_cents).toBe(10000n);
    expect(lines.find((l) => l.role === "cogs_0")?.credit_cents).toBe(4000n);
    expect(lines.find((l) => l.role === "inventory_asset")?.debit_cents).toBe(4000n);
    expect(lines.find((l) => l.role === "accounts_receivable")?.credit_cents).toBe(10000n);
  });

  it("pins a CM with an order discount: subtotal is GROSS, income Σ = subtotal via largest remainder", () => {
    // subtotal (gross) 10000, discount 1000, tax 0, shipping 0 → total = subtotal - discount = 9000.
    // Line weights (7000 + 3300 = 10300) do NOT sum to subtotal — forces a real reallocation.
    const snapshot: CreditMemoSnapshot = {
      totalCents: 9000n,
      subtotalCents: 10000n,
      discountCents: 1000n,
      shippingCents: 0n,
      taxCents: 0n,
      isFraudWriteoff: false,
      lines: [
        {
          quantity: 1,
          damagedQty: 0,
          lineTotalCents: 7000n,
          unitCostDollars: null,
          incomeAccount: map.income_default,
          cogsAccount: null,
        },
        {
          quantity: 1,
          damagedQty: 0,
          lineTotalCents: 3300n,
          unitCostDollars: null,
          incomeAccount: map.income_default,
          cogsAccount: null,
        },
      ],
    };
    const lines = buildCreditMemoLines(snapshot, map);
    const incomeSum = lines
      .filter((l) => l.role.startsWith("income_"))
      .reduce((a, l) => a + l.debit_cents, 0n);
    expect(incomeSum).toBe(10000n); // == subtotal, exact — no rounding line
    expect(lines.some((l) => l.role === "rounding")).toBe(false);
    expect(lines.find((l) => l.role === "sales_discounts")?.credit_cents).toBe(1000n);
    expect(lines.find((l) => l.role === "accounts_receivable")?.credit_cents).toBe(9000n);
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });

  it("excludes damaged units from restock and COGS reversal", () => {
    const snapshot: CreditMemoSnapshot = {
      totalCents: 10000n,
      subtotalCents: 10000n,
      discountCents: 0n,
      shippingCents: 0n,
      taxCents: 0n,
      isFraudWriteoff: false,
      lines: [
        {
          quantity: 2,
          damagedQty: 1, // sólo 1 unidad vuelve a stock
          lineTotalCents: 10000n,
          unitCostDollars: "20.00",
          incomeAccount: map.income_default,
          cogsAccount: map.cogs_default,
        },
      ],
    };
    const lines = buildCreditMemoLines(snapshot, map);
    expect(lines.find((l) => l.role === "cogs_0")?.credit_cents).toBe(2000n); // 1 unidad × $20
    expect(lines.find((l) => l.role === "inventory_asset")?.debit_cents).toBe(2000n);
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });

  it("skips restock/COGS entirely when every returned unit was damaged", () => {
    const snapshot: CreditMemoSnapshot = {
      totalCents: 10000n,
      subtotalCents: 10000n,
      discountCents: 0n,
      shippingCents: 0n,
      taxCents: 0n,
      isFraudWriteoff: false,
      lines: [
        {
          quantity: 2,
          damagedQty: 2,
          lineTotalCents: 10000n,
          unitCostDollars: "20.00",
          incomeAccount: map.income_default,
          cogsAccount: map.cogs_default,
        },
      ],
    };
    const lines = buildCreditMemoLines(snapshot, map);
    expect(lines.some((l) => l.role.startsWith("cogs_"))).toBe(false);
    expect(lines.some((l) => l.role === "inventory_asset")).toBe(false);
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });

  it("routes a fraud/bad-debt write-off to bad_debt vs accounts_receivable only, header-only", () => {
    const snapshot: CreditMemoSnapshot = {
      totalCents: 5000n,
      subtotalCents: 5000n,
      discountCents: 0n,
      shippingCents: 0n,
      taxCents: 0n,
      isFraudWriteoff: true,
      lines: [
        {
          quantity: 1,
          damagedQty: 0,
          lineTotalCents: 5000n,
          unitCostDollars: "20.00",
          incomeAccount: map.income_default,
          cogsAccount: map.cogs_default,
        },
      ],
    };
    const lines = buildCreditMemoLines(snapshot, map);
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.role === "bad_debt")?.debit_cents).toBe(5000n);
    expect(lines.find((l) => l.role === "accounts_receivable")?.credit_cents).toBe(5000n);
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });

  it("buildFraudWriteoffLines rejects a non-positive total", () => {
    expect(() => buildFraudWriteoffLines(0n, map)).toThrow(LedgerError);
  });

  it("derives income from total (not subtotal) when they disagree", () => {
    const snapshot: CreditMemoSnapshot = {
      totalCents: 9997n,
      subtotalCents: 10000n, // present but MUST be ignored
      discountCents: 0n,
      shippingCents: 0n,
      taxCents: 0n,
      isFraudWriteoff: false,
      lines: [
        {
          quantity: 1,
          damagedQty: 0,
          lineTotalCents: 10000n,
          unitCostDollars: null,
          incomeAccount: map.income_default,
          cogsAccount: null,
        },
      ],
    };
    const lines = buildCreditMemoLines(snapshot, map);
    expect(lines.some((l) => l.role === "rounding")).toBe(false);
    expect(lines.find((l) => l.role === "income_0")?.debit_cents).toBe(9997n);
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });

  it("(pattern a) mirrors a negative-total CM: builds on |values| and swaps every debit/credit", () => {
    // Real sandbox row: CM-1162, total=subtotal=-668, is_internal_adjustment
    // metadata (skipped upstream by postCreditMemo) — this pins the builder's
    // OWN sign-handling independent of that upstream skip.
    const snapshot: CreditMemoSnapshot = {
      totalCents: -668n,
      subtotalCents: -668n,
      discountCents: 0n,
      shippingCents: 0n,
      taxCents: 0n,
      isFraudWriteoff: false,
      lines: [
        {
          quantity: 1,
          damagedQty: 0,
          lineTotalCents: -668n,
          unitCostDollars: null,
          incomeAccount: map.income_default,
          cogsAccount: null,
        },
      ],
    };
    const lines = buildCreditMemoLines(snapshot, map);
    // Normal orientation would debit income/credit AR; mirrored swaps both.
    expect(lines.find((l) => l.role === "income_0")?.credit_cents).toBe(668n);
    expect(lines.find((l) => l.role === "accounts_receivable")?.debit_cents).toBe(668n);
    expect(sumDebits(lines)).toBe(sumCredits(lines));
    expect(sumDebits(lines)).toBe(668n);
  });

  it("(pattern b) total = 0 with a real cost: no AR/income lines, only COGS/inventory", () => {
    // Real sandbox row: CM-1112, total=0, one line with average_unit_cost=2.54.
    const snapshot: CreditMemoSnapshot = {
      totalCents: 0n,
      subtotalCents: 0n,
      discountCents: 0n,
      shippingCents: 0n,
      taxCents: 0n,
      isFraudWriteoff: false,
      lines: [
        {
          quantity: 1,
          damagedQty: 0,
          lineTotalCents: 0n,
          unitCostDollars: "2.54",
          incomeAccount: map.income_default,
          cogsAccount: map.cogs_default,
        },
      ],
    };
    const lines = buildCreditMemoLines(snapshot, map);
    expect(lines.some((l) => l.role === "accounts_receivable")).toBe(false);
    expect(lines.some((l) => l.role.startsWith("income_"))).toBe(false);
    expect(lines).toHaveLength(2); // cogs_0 + inventory_asset only
    expect(lines.find((l) => l.role === "cogs_0")?.credit_cents).toBe(254n);
    expect(lines.find((l) => l.role === "inventory_asset")?.debit_cents).toBe(254n);
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });

  it("(pattern c) rejects a genuinely inconsistent document: shipping+tax exceed total+discount", () => {
    const snapshot: CreditMemoSnapshot = {
      totalCents: 100n,
      subtotalCents: 100n,
      discountCents: 0n,
      shippingCents: 50n,
      taxCents: 100n,
      isFraudWriteoff: false,
      lines: [
        {
          quantity: 1,
          damagedQty: 0,
          lineTotalCents: 100n,
          unitCostDollars: null,
          incomeAccount: map.income_default,
          cogsAccount: null,
        },
      ],
    };
    try {
      buildCreditMemoLines(snapshot, map);
      throw new Error("expected buildCreditMemoLines to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LedgerError);
      expect((err as LedgerError).code).toBe("GL_UNBALANCED_DOCUMENT");
      expect((err as LedgerError).details).toMatchObject({
        reason: "shipping+tax exceed total+discount",
      });
    }
  });
});
