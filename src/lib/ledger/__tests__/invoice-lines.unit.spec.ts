import { buildInvoiceLines } from "../lines/invoice";
import { LedgerError, InvoiceSnapshot } from "../types";
import { fakeAccountMap, sumCredits, sumDebits } from "./fixtures";

describe("buildInvoiceLines", () => {
  const map = fakeAccountMap();

  it("balances a simple sale with COGS (subtotal already net of order discount)", () => {
    const snapshot: InvoiceSnapshot = {
      totalCents: 10000n,
      subtotalCents: 10000n,
      discountCents: 0n,
      shippingCents: 0n,
      taxCents: 0n,
      lines: [
        {
          quantity: 2,
          lineNetCents: 10000n,
          unitCostDollars: "20.00",
          incomeAccount: map.income_default,
          cogsAccount: map.cogs_default,
        },
      ],
    };
    const lines = buildInvoiceLines(snapshot, map);
    expect(sumDebits(lines)).toBe(sumCredits(lines));
    expect(lines.find((l) => l.role === "income_0")?.credit_cents).toBe(10000n);
    expect(lines.find((l) => l.role === "cogs_0")?.debit_cents).toBe(4000n);
    expect(lines.find((l) => l.role === "inventory_asset")?.credit_cents).toBe(4000n);
    expect(lines.find((l) => l.role === "accounts_receivable")?.debit_cents).toBe(10000n);
  });

  it("pins invoice #21740: weights already sum to subtotal+discount, share == weight", () => {
    // subtotal 29683, discount 2581, tax 2078, total 31761 (= subtotal + tax).
    // lines' raw net cents sum to 32264 == subtotal + discount exactly.
    const snapshot: InvoiceSnapshot = {
      totalCents: 31761n,
      subtotalCents: 29683n,
      discountCents: 2581n,
      shippingCents: 0n,
      taxCents: 2078n,
      lines: [
        {
          quantity: 1,
          lineNetCents: 20000n,
          unitCostDollars: null,
          incomeAccount: map.income_default,
          cogsAccount: null,
        },
        {
          quantity: 1,
          lineNetCents: 12264n,
          unitCostDollars: null,
          incomeAccount: map.income_default,
          cogsAccount: null,
        },
      ],
    };
    const lines = buildInvoiceLines(snapshot, map);
    const incomeSum = lines
      .filter((l) => l.role.startsWith("income_"))
      .reduce((a, l) => a + l.credit_cents, 0n);
    expect(incomeSum).toBe(32264n); // subtotal + discount, exact — no rounding line
    expect(lines.some((l) => l.role === "rounding")).toBe(false);
    expect(lines.find((l) => l.role === "sales_discounts")?.debit_cents).toBe(2581n);
    expect(lines.find((l) => l.role === "sales_tax_payable")?.credit_cents).toBe(2078n);
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });

  it("pins invoice #21716: net_total_cents sums to subtotal (NOT subtotal+discount) — largest remainder reallocates to the gross target", () => {
    // subtotal 122400, discount 40800, tax 8568, total 130968 (= subtotal + tax).
    // line weights sum to 122400 (subtotal, not subtotal+discount) — the
    // regression this pins: never trust Σ net_total_cents as the gross target.
    const snapshot: InvoiceSnapshot = {
      totalCents: 130968n,
      subtotalCents: 122400n,
      discountCents: 40800n,
      shippingCents: 0n,
      taxCents: 8568n,
      lines: [
        {
          quantity: 1,
          lineNetCents: 70000n,
          unitCostDollars: null,
          incomeAccount: map.income_default,
          cogsAccount: null,
        },
        {
          quantity: 1,
          lineNetCents: 52400n,
          unitCostDollars: null,
          incomeAccount: map.income_default,
          cogsAccount: null,
        },
      ],
    };
    const lines = buildInvoiceLines(snapshot, map);
    const incomeSum = lines
      .filter((l) => l.role.startsWith("income_"))
      .reduce((a, l) => a + l.credit_cents, 0n);
    expect(incomeSum).toBe(163200n); // subtotal + discount, EXACT despite weights summing to subtotal only
    expect(lines.find((l) => l.role === "income_0")?.credit_cents).toBe(93333n);
    expect(lines.find((l) => l.role === "income_1")?.credit_cents).toBe(69867n);
    expect(lines.some((l) => l.role === "rounding")).toBe(false);
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });

  it("balances order discount, shipping and tax together (total = subtotal + shipping + tax)", () => {
    const snapshot: InvoiceSnapshot = {
      totalCents: 11200n, // 10000 + 500 + 700
      subtotalCents: 10000n,
      discountCents: 1000n,
      shippingCents: 500n,
      taxCents: 700n,
      lines: [
        {
          quantity: 1,
          lineNetCents: 11000n, // subtotal + discount target
          unitCostDollars: null,
          incomeAccount: map.income_default,
          cogsAccount: null,
        },
      ],
    };
    const lines = buildInvoiceLines(snapshot, map);
    expect(sumDebits(lines)).toBe(sumCredits(lines));
    expect(lines.find((l) => l.role === "income_0")?.credit_cents).toBe(11000n);
    expect(lines.find((l) => l.role === "sales_discounts")?.debit_cents).toBe(1000n);
    expect(lines.find((l) => l.role === "shipping_income")?.credit_cents).toBe(500n);
    expect(lines.find((l) => l.role === "sales_tax_payable")?.credit_cents).toBe(700n);
  });

  it("emits no income lines when Σweights = 0 and discount = 0 (nothing to allocate)", () => {
    const snapshot: InvoiceSnapshot = {
      totalCents: 0n,
      subtotalCents: 0n,
      discountCents: 0n,
      shippingCents: 0n,
      taxCents: 0n,
      lines: [
        {
          quantity: 1,
          lineNetCents: 0n,
          unitCostDollars: null,
          incomeAccount: map.income_default,
          cogsAccount: null,
        },
      ],
    };
    const lines = buildInvoiceLines(snapshot, map);
    expect(lines.some((l) => l.role.startsWith("income_"))).toBe(false);
  });

  it("allocates equally when Σweights = 0 but discount > 0", () => {
    const snapshot: InvoiceSnapshot = {
      totalCents: 0n,
      subtotalCents: 0n,
      discountCents: 100n,
      shippingCents: 0n,
      taxCents: 0n,
      lines: [
        {
          quantity: 1,
          lineNetCents: 0n,
          unitCostDollars: null,
          incomeAccount: map.income_default,
          cogsAccount: null,
        },
        {
          quantity: 1,
          lineNetCents: 0n,
          unitCostDollars: null,
          incomeAccount: map.income_default,
          cogsAccount: null,
        },
      ],
    };
    const lines = buildInvoiceLines(snapshot, map);
    expect(lines.find((l) => l.role === "income_0")?.credit_cents).toBe(50n);
    expect(lines.find((l) => l.role === "income_1")?.credit_cents).toBe(50n);
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });

  it("skips COGS entirely for an item without a variant", () => {
    const snapshot: InvoiceSnapshot = {
      totalCents: 5000n,
      subtotalCents: 5000n,
      discountCents: 0n,
      shippingCents: 0n,
      taxCents: 0n,
      lines: [
        {
          quantity: 1,
          lineNetCents: 5000n,
          unitCostDollars: "10.00",
          incomeAccount: map.income_default,
          cogsAccount: null, // no variant_id
        },
      ],
    };
    const lines = buildInvoiceLines(snapshot, map);
    expect(lines.some((l) => l.role.startsWith("cogs_"))).toBe(false);
    expect(lines.some((l) => l.role === "inventory_asset")).toBe(false);
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });

  it("skips COGS for a line with zero/null cost even with a variant", () => {
    const snapshot: InvoiceSnapshot = {
      totalCents: 5000n,
      subtotalCents: 5000n,
      discountCents: 0n,
      shippingCents: 0n,
      taxCents: 0n,
      lines: [
        {
          quantity: 1,
          lineNetCents: 5000n,
          unitCostDollars: null,
          incomeAccount: map.income_default,
          cogsAccount: map.cogs_default,
        },
      ],
    };
    const lines = buildInvoiceLines(snapshot, map);
    expect(lines.some((l) => l.role.startsWith("cogs_"))).toBe(false);
    expect(lines.some((l) => l.role === "inventory_asset")).toBe(false);
  });

  it("derives income from total (not subtotal) when subtotal disagrees with total — invoice #20563 pattern", () => {
    // Real sandbox row: subtotal=633463 but total=626053 (subtotal is stale on
    // this invoice); the target must come from total, never from subtotal.
    const snapshot: InvoiceSnapshot = {
      totalCents: 626053n,
      subtotalCents: 633463n, // present in the row but MUST be ignored
      discountCents: 158417n,
      shippingCents: 0n,
      taxCents: 44342n,
      lines: [
        {
          quantity: 120,
          lineNetCents: 633480n,
          unitCostDollars: null,
          incomeAccount: map.income_default,
          cogsAccount: null,
        },
      ],
    };
    const lines = buildInvoiceLines(snapshot, map);
    expect(lines.some((l) => l.role === "rounding")).toBe(false);
    expect(lines.find((l) => l.role === "income_0")?.credit_cents).toBe(740128n); // total - shipping - tax + discount
    expect(lines.find((l) => l.role === "accounts_receivable")?.debit_cents).toBe(626053n);
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });

  it("(pattern a) mirrors a negative-total invoice: builds on |values| and swaps every debit/credit", () => {
    // Real sandbox row: total=subtotal=-18790, no discount/shipping/tax/cost.
    const snapshot: InvoiceSnapshot = {
      totalCents: -18790n,
      subtotalCents: -18790n,
      discountCents: 0n,
      shippingCents: 0n,
      taxCents: 0n,
      lines: [
        {
          quantity: 1,
          lineNetCents: -18790n,
          unitCostDollars: null,
          incomeAccount: map.income_default,
          cogsAccount: null,
        },
      ],
    };
    const lines = buildInvoiceLines(snapshot, map);
    // Mirrored: income is DEBITED, AR is CREDITED (economically a return).
    expect(lines.find((l) => l.role === "income_0")?.debit_cents).toBe(18790n);
    expect(lines.find((l) => l.role === "income_0")?.credit_cents).toBe(0n);
    expect(lines.find((l) => l.role === "accounts_receivable")?.credit_cents).toBe(18790n);
    expect(lines.find((l) => l.role === "accounts_receivable")?.debit_cents).toBe(0n);
    expect(sumDebits(lines)).toBe(sumCredits(lines));
    expect(sumDebits(lines)).toBe(18790n);
  });

  it("(pattern b) total = 0 with a real cost: no AR/income lines (0¢), only COGS/inventory", () => {
    const snapshot: InvoiceSnapshot = {
      totalCents: 0n,
      subtotalCents: 0n,
      discountCents: 0n,
      shippingCents: 0n,
      taxCents: 0n,
      lines: [
        {
          quantity: 4,
          lineNetCents: 0n,
          unitCostDollars: "13.67795",
          incomeAccount: map.income_default,
          cogsAccount: map.cogs_default,
        },
      ],
    };
    const lines = buildInvoiceLines(snapshot, map);
    expect(lines.some((l) => l.role === "accounts_receivable")).toBe(false);
    expect(lines.some((l) => l.role.startsWith("income_"))).toBe(false);
    expect(lines).toHaveLength(2); // cogs_0 + inventory_asset only
    expect(lines.find((l) => l.role === "cogs_0")?.debit_cents).toBe(
      lines.find((l) => l.role === "inventory_asset")?.credit_cents
    );
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });

  it("(pattern b') total = 0 but a 100%-discounted item still books gross income vs. sales_discounts", () => {
    // Real sandbox row: total=0, discount=27596 (the whole item was given away),
    // weights sum to 0 (net_total_cents=0) — must fall back to equal allocation.
    const snapshot: InvoiceSnapshot = {
      totalCents: 0n,
      subtotalCents: 0n,
      discountCents: 27596n,
      shippingCents: 0n,
      taxCents: 0n,
      lines: [
        {
          quantity: 4,
          lineNetCents: 0n,
          unitCostDollars: "0.59",
          incomeAccount: map.income_default,
          cogsAccount: map.cogs_default,
        },
      ],
    };
    const lines = buildInvoiceLines(snapshot, map);
    expect(lines.some((l) => l.role === "accounts_receivable")).toBe(false);
    expect(lines.find((l) => l.role === "income_0")?.credit_cents).toBe(27596n);
    expect(lines.find((l) => l.role === "sales_discounts")?.debit_cents).toBe(27596n);
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });

  it("(pattern c) rejects a genuinely inconsistent document: shipping+tax exceed total+discount", () => {
    const snapshot: InvoiceSnapshot = {
      totalCents: 100n,
      subtotalCents: 100n,
      discountCents: 0n,
      shippingCents: 50n,
      taxCents: 100n, // 50 + 100 = 150 > 100 + 0
      lines: [
        {
          quantity: 1,
          lineNetCents: 100n,
          unitCostDollars: null,
          incomeAccount: map.income_default,
          cogsAccount: null,
        },
      ],
    };
    try {
      buildInvoiceLines(snapshot, map);
      throw new Error("expected buildInvoiceLines to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LedgerError);
      expect((err as LedgerError).code).toBe("GL_UNBALANCED_DOCUMENT");
      expect((err as LedgerError).details).toMatchObject({
        reason: "shipping+tax exceed total+discount",
      });
    }
  });
});
