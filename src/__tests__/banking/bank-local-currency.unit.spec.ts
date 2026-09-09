import { receiptMapping } from "../../lib/banking/receipts-setup";

// QuickBooks Desktop without multicurrency reports no currency on ANY account: 11 of the 12 real Bank accounts
// (2026-09-09). The setup's local_usd_attested must cover Bank accounts exactly like AR / Undeposited Funds.
describe("bank local-currency attestation", () => {
  const bank = (currency: string | null) => ({ id: "80000006", name: "Chase Bank Checking 7223", account_type: "Bank", currency });
  it("treats a Bank account without a currency ref as USD when the operator attested local USD", () => {
    expect(receiptMapping(bank(null), true).currency).toBe("USD");
    expect(receiptMapping(bank(null), true).qb_currency_ref).toBeNull();
  });
  it("still fails closed without the attestation or with an explicit non-USD ref", () => {
    expect(receiptMapping(bank(null), false).currency).toBeNull();
    expect(receiptMapping(bank("CAD"), true).currency).toBeNull();
    expect(receiptMapping(bank("US Dollar"), false).currency).toBe("USD");
  });
  it("keeps Income and Equity outside the attested shortcut", () => {
    expect(receiptMapping({ id: "x", name: "Sales", account_type: "Income", currency: null }, true).currency).toBeNull();
  });
});
