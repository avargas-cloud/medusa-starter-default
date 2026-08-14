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
  return false;
}
