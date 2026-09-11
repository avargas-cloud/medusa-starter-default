import { sanitizeRole, signedLine } from "../money";
import { LedgerAccount, LedgerLine, PurchaseAccountMap } from "../types";

export interface VendorBillClassifiedLine {
  /** `qb_account_list_id` de la línea, ya resuelto a `LedgerAccount`. */
  account: LedgerAccount;
  /** `VENDOR_BILL_LINE_CENTS` de la línea (siempre no-negativo en la práctica). */
  amountCents: bigint;
}

export interface VendorBillSnapshot {
  /** Σ `VENDOR_BILL_LINE_CENTS` sobre TODAS las líneas — `recompute-bill-finance.ts:106-111`. */
  payableCents: bigint;
  /** Σ receipts atados a este bill, qty × costo de recepción. 0 si ninguno. */
  offsetCents: bigint;
  /** Σ `variant_cost_event.cogs_true_up_cents` activos de este bill. 0 si ninguno. */
  trueUpCents: bigint;
  /** Líneas `line_type='qb_account'` EN el scope de `period-costs` (gasto del período, no capitalizan). */
  expensedLines: VendorBillClassifiedLine[];
  /** Bill `adopted` sin líneas propias — payable viene de `qb_amount_due_cents`. */
  adoptedNoLines: { qbAmountDueCents: bigint } | null;
}

/**
 * gl-purchases-v2 §2/§1: una fórmula única cubre el bill regular Y el
 * hermano/suelto — la diferencia entre ambos es sólo qué valores trae el
 * snapshot (`offsetCents`/`trueUpCents` son 0 en un hermano sin receipts
 * atados). Todo lo que NO es gasto del período (`expensedLines`, por la
 * MISMA regla de `VENDOR_BILL_PERIOD_COST_SCOPE_SQL` que usa el P&L) termina
 * en `inventory_asset` vía el neto:
 *
 *   inventory_asset = payable − offset − ΣexpensedLines − trueUp
 *
 * Balance por construcción: offset + inventory_asset + trueUp + Σexpensed −
 * payable = 0 siempre — no hay línea de redondeo que tolerar.
 */
export function buildVendorBillLines(
  snapshot: VendorBillSnapshot,
  map: PurchaseAccountMap
): LedgerLine[] {
  if (snapshot.adoptedNoLines) {
    const amount = snapshot.adoptedNoLines.qbAmountDueCents;
    const debit = signedLine("inventory_asset", map.inventory_asset, amount);
    const credit = signedLine("accounts_payable", map.accounts_payable, -amount);
    const lines: LedgerLine[] = [];
    if (debit) lines.push(debit);
    if (credit) lines.push(credit);
    return lines;
  }

  const expensedByAccount = new Map<string, { account: LedgerAccount; cents: bigint }>();
  let expensedSum = 0n;
  for (const l of snapshot.expensedLines) {
    const cur = expensedByAccount.get(l.account.id) ?? { account: l.account, cents: 0n };
    cur.cents += l.amountCents;
    expensedByAccount.set(l.account.id, cur);
    expensedSum += l.amountCents;
  }

  const netInventoryAsset =
    snapshot.payableCents - snapshot.offsetCents - expensedSum - snapshot.trueUpCents;

  const lines: LedgerLine[] = [];
  const offsetLine = signedLine("inventory_offset", map.inventory_offset, snapshot.offsetCents);
  if (offsetLine) lines.push(offsetLine);
  const invLine = signedLine("inventory_asset", map.inventory_asset, netInventoryAsset);
  if (invLine) lines.push(invLine);
  const trueUpLine = signedLine("cogs_default", map.cogs_default, snapshot.trueUpCents);
  if (trueUpLine) lines.push(trueUpLine);
  for (const { account, cents } of expensedByAccount.values()) {
    const l = signedLine(sanitizeRole("qb_account", account.id), account, cents);
    if (l) lines.push(l);
  }
  const apLine = signedLine("accounts_payable", map.accounts_payable, -snapshot.payableCents);
  if (apLine) lines.push(apLine);
  return lines;
}
