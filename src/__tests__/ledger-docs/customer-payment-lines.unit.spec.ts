import { buildCustomerPaymentLines } from "../../lib/ledger/lines/customer-payment";
import { surchargeCentsFromMetadata } from "../../lib/finance/payment-surcharge";
import { LedgerError } from "../../lib/ledger/types";
import { account, sumCredits, sumDebits } from "./fixtures";

describe("buildCustomerPaymentLines", () => {
  const undepositedFunds = account("UF-1", "OtherCurrentAsset");
  const accountsReceivable = account("AR-1", "AccountsReceivable");
  const surchargeAccount = account("CCS-1", "Income");
  const map = {
    accounts_receivable: accountsReceivable,
    undeposited_funds: undepositedFunds,
    sales_tax_payable: account("STP", "OtherCurrentLiability"),
    inventory_asset: account("INV", "OtherCurrentAsset"),
    sales_discounts: account("SD", "Income"),
    shipping_income: account("SI", "Income"),
    income_default: account("ID", "Income"),
    cogs_default: account("CD", "CostOfGoodsSold"),
    bad_debt: account("BD", "Expense"),
  };

  it("surcharge 0 → 2 líneas, comportamiento legacy", () => {
    const lines = buildCustomerPaymentLines(
      { type: "payment", amountCents: 23281n, surchargeCents: 0n },
      map
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      role: "undeposited_funds",
      account: undepositedFunds,
      debit_cents: 23281n,
      credit_cents: 0n,
    });
    expect(lines[1]).toMatchObject({
      role: "accounts_receivable",
      account: accountsReceivable,
      debit_cents: 0n,
      credit_cents: 23281n,
    });
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });

  it("surcharge 698 → 3 líneas, balanceado, roles y montos según spec", () => {
    const lines = buildCustomerPaymentLines(
      { type: "payment", amountCents: 23281n, surchargeCents: 698n },
      map,
      surchargeAccount
    );
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({
      role: "undeposited_funds",
      account: undepositedFunds,
      debit_cents: 23281n + 698n,
      credit_cents: 0n,
    });
    expect(lines[1]).toMatchObject({
      role: "accounts_receivable",
      account: accountsReceivable,
      debit_cents: 0n,
      credit_cents: 23281n,
    });
    expect(lines[2]).toMatchObject({
      role: "credit_card_surcharge",
      account: surchargeAccount,
      debit_cents: 0n,
      credit_cents: 698n,
    });
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });

  it("surcharge > 0 sin surchargeAccount → GL_ACCOUNT_MAP_MISSING", () => {
    expect(() =>
      buildCustomerPaymentLines(
        { type: "payment", amountCents: 23281n, surchargeCents: 698n },
        map
      )
    ).toThrow(
      expect.objectContaining({
        code: "GL_ACCOUNT_MAP_MISSING",
        details: expect.objectContaining({ missing: ["credit_card_surcharge"] }),
      })
    );
  });

  it("refund con surcharge lo ignora → 2 líneas, sin línea de surcharge", () => {
    const lines = buildCustomerPaymentLines(
      { type: "refund", amountCents: 23281n, surchargeCents: 698n },
      map,
      surchargeAccount
    );
    expect(lines).toHaveLength(2);
    expect(lines.some((l) => l.role === "credit_card_surcharge")).toBe(false);
    expect(lines[0]).toMatchObject({
      role: "accounts_receivable",
      debit_cents: 23281n,
      credit_cents: 0n,
    });
    expect(lines[1]).toMatchObject({
      role: "undeposited_funds",
      debit_cents: 0n,
      credit_cents: 23281n,
    });
    expect(sumDebits(lines)).toBe(sumCredits(lines));
  });

  it("amountCents <= 0 sigue rechazando GL_SOURCE_INVALID (sin cambios)", () => {
    expect(() =>
      buildCustomerPaymentLines({ type: "payment", amountCents: 0n, surchargeCents: 0n }, map)
    ).toThrow(expect.objectContaining({ code: "GL_SOURCE_INVALID" }));
  });
});

describe("surchargeCentsFromMetadata", () => {
  it("lee dejavoo_surcharge_cents (terminal)", () => {
    expect(surchargeCentsFromMetadata({ dejavoo_surcharge_cents: 698 })).toBe(698);
  });

  it("lee bams_surcharge_fee_cents (online)", () => {
    expect(surchargeCentsFromMetadata({ bams_surcharge_fee_cents: 450 })).toBe(450);
  });

  it("si ambas están presentes, dejavoo gana", () => {
    expect(
      surchargeCentsFromMetadata({ dejavoo_surcharge_cents: 698, bams_surcharge_fee_cents: 450 })
    ).toBe(698);
  });

  it.each([
    ["negativo", { dejavoo_surcharge_cents: -1 }],
    ["NaN", { dejavoo_surcharge_cents: Number.NaN }],
    ["string", { dejavoo_surcharge_cents: "698" }],
    ["no finito", { dejavoo_surcharge_cents: Infinity }],
    ["fraccional", { dejavoo_surcharge_cents: 6.98 }],
  ])("%s → 0", (_label, metadata) => {
    expect(surchargeCentsFromMetadata(metadata)).toBe(0);
  });

  it("undefined/null → 0", () => {
    expect(surchargeCentsFromMetadata(undefined)).toBe(0);
    expect(surchargeCentsFromMetadata(null)).toBe(0);
  });
});
