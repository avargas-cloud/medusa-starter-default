export type VendorBillAccount = {
  full_name: string;
  account_type: string;
};

export function accountAllowedForVendorBillType(
  billType: string,
  account: VendorBillAccount
) {
  const fullName = account.full_name.toLowerCase();
  if (billType === "service") {
    return (
      fullName === "commission for purchase:veetech representative" ||
      // Order Commissions v1 (docs/ORDER_COMMISSIONS_PLAN.md §11): el bill del
      // caso 1 factura la comisión de VENTA contra esta cuenta COGS.
      fullName === "commission for sale:referral"
    );
  }
  if (billType === "freight") {
    return (
      account.account_type === "CostOfGoodsSold" &&
      fullName.startsWith("freight and shipping costs")
    );
  }
  if (billType === "tariff") {
    return (
      fullName === "special duties" ||
      (account.account_type === "CostOfGoodsSold" &&
        fullName.startsWith("duties") &&
        fullName !== "duties payable")
    );
  }
  if (billType === "expense") {
    // Operating expenses (supplies, installs, office costs). Broad on purpose:
    // unlike service/freight/tariff, an expense bill never pools into a
    // regular bill's landed cost, so there is no account to protect — but it
    // stays out of COGS/Income/Balance-Sheet accounts, which would misstate
    // margins or the balance sheet if a bill posted against them.
    return (
      account.account_type === "Expense" ||
      account.account_type === "OtherExpense"
    );
  }
  return false;
}
