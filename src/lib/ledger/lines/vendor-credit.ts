import { sanitizeRole, signedLine } from "../money";
import { LedgerAccount, LedgerLine, PurchaseAccountMap } from "../types";

export interface VendorCreditAccountLine {
  account: LedgerAccount;
  amountCents: bigint;
}

export interface VendorCreditSnapshot {
  totalCents: bigint;
  /** Σ qty × costo de las líneas `product` — todas caen a `inventory_asset`. */
  productAmountCents: bigint;
  /** Líneas `qb_account`, cada una a su propia cuenta. */
  accountLines: VendorCreditAccountLine[];
}

/**
 * gl-purchases-v2 §2: un vendor credit REDUCE lo que se debe (débito AP) y
 * revierte el lado que originó el crédito — inventario si es un producto
 * devuelto, la cuenta de gasto si es un ajuste de cuenta. Balance por
 * construcción: total = productAmountCents + ΣaccountLines (invariante que
 * el módulo de vendor-credits garantiza al guardar; acá NO se recalcula, se
 * confía en el snapshot).
 */
export function buildVendorCreditLines(
  snapshot: VendorCreditSnapshot,
  map: PurchaseAccountMap
): LedgerLine[] {
  const lines: LedgerLine[] = [];
  const apLine = signedLine("accounts_payable", map.accounts_payable, snapshot.totalCents);
  if (apLine) lines.push(apLine);

  const inventoryLine = signedLine(
    "inventory_asset",
    map.inventory_asset,
    -snapshot.productAmountCents
  );
  if (inventoryLine) lines.push(inventoryLine);

  const byAccount = new Map<string, { account: LedgerAccount; cents: bigint }>();
  for (const l of snapshot.accountLines) {
    const cur = byAccount.get(l.account.id) ?? { account: l.account, cents: 0n };
    cur.cents += l.amountCents;
    byAccount.set(l.account.id, cur);
  }
  for (const { account, cents } of byAccount.values()) {
    const l = signedLine(sanitizeRole("qb_account", account.id), account, -cents);
    if (l) lines.push(l);
  }
  return lines;
}
