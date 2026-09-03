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
      fullName === "commission for sale:referral" ||
      // Order Outsourced Services v1: el costo de un servicio subcontratado
      // (programación, armado, instalación) atado a una orden de venta.
      //
      // Va a COGS y no a `expense` a propósito: es costo directo de una venta
      // concreta, y una cuenta de gasto operativo desalinearía el margen de esa
      // orden. El árbol `Subcontractor Labor` ya existía en QuickBooks con
      // hijas por proveedor, así que esto no inventa cuentas — habilita las que
      // el contador ya usa.
      //
      // El prefijo cubre las hijas (`Subcontractor Labor:Bella Lighting`, …).
      // Que el conjunto sea DISJUNTO del de comisiones es lo que impide que un
      // mismo bill se reclame de los dos lados: cada feature exige que TODAS
      // las líneas apunten a SU cuenta, así que un bill de subcontrato es
      // inválido como bill de comisión y viceversa.
      // `verify-outsourced-services.ts` afirma esa disjunción.
      (account.account_type === "CostOfGoodsSold" &&
        fullName.startsWith("subcontractor labor"))
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
