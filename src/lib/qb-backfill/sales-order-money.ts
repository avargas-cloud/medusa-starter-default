/**
 * src/lib/qb-backfill/sales-order-money.ts
 *
 * El dinero de una orden backfilleada desde QB, en la forma que Medusa
 * DERIVA (tax lines por ítem, adjustments por ítem, shipping method) — para
 * que `order_summary` y el `total/tax_total/discount_total/shipping_total`
 * que calcula la API coincidan con la verdad de QB (`pos_invoice`,
 * `order.metadata.pos_total`) al centavo.
 *
 * Espeja el camino nativo del POS, no lo reinventa:
 *   - tax lines: `lib/order-money/order-tax-lines.ts` (`replaceOrderTaxLines`)
 *     escribe UNA tax line por ítem, `FL` @ 7 para las gravadas y `EXEMPT` @ 0
 *     para las exentas; el total del impuesto se redondea UNA vez sobre el
 *     agregado (paridad QB) y se PARCHEA en `order_summary`.
 *   - descuento: `lib/order-discount/allocation.ts` (`allocateOrderDiscount`,
 *     fixed) reparte el monto por línea proporcional al neto con residuo por
 *     mayor resto — se reusa tal cual, es la única fórmula del sistema.
 *   - envío: un `order_shipping_method` con el monto de QB (sin tax lines: la
 *     línea SHIPPING de QB va `Non`).
 *
 * ── Política de la tasa (±1¢) ────────────────────────────────────────────────
 * Medusa sólo acepta una TASA por tax line y acumula `Σ (neto − adj) × tasa`
 * sin redondear. QB guarda el impuesto ya redondeado en el header. Entonces:
 *   - `tax = 0`                            → todas EXEMPT @ 0 (`none`).
 *   - `round(base × 7%) == tax`            → FL @ 7 (`statutory`): la suma de
 *     Medusa cae a < 0.5¢ del header, y el summary lleva el centavo exacto.
 *   - si no                                → FL @ tasa efectiva `tax / base`
 *     (`effective`): QB gravó un conjunto de líneas distinto del que el POS
 *     conoce (p.ej. un servicio `Non` cuyo producto es gravable). Con la tasa
 *     efectiva `Σ` reproduce el header al centavo; las líneas quedan marcadas
 *     `qb_effective_rate` en la description para que se note.
 *   - `tax > 0` sin base gravable (todas las líneas `Non` o neto 0) → si NO hay
 *     ninguna línea gravada, se gravan TODAS (QB dice que hubo impuesto y el
 *     flag del POS es un snapshot del producto, no la verdad del documento);
 *     si la base sigue en 0, `ok: false` — no se inventa un impuesto.
 *
 * Todo en CENTS enteros; los DTO de Medusa piden dólares y se convierten
 * en el borde (`/ 100`), nunca antes.
 */
import { allocateOrderDiscount } from "../order-discount/allocation";

export const FL_TAX_RATE = 7;
export const TAX_CODE_FL = "FL";
export const TAX_DESC_FL = "Florida Sales Tax";
export const TAX_DESC_FL_EFFECTIVE = "Florida Sales Tax (qb_effective_rate)";
export const TAX_CODE_EXEMPT = "EXEMPT";
export const TAX_DESC_EXEMPT = "Tax Exempt";
export const QB_DISCOUNT_CODE = "QB-DISCOUNT";
export const QB_DISCOUNT_DESC = "QuickBooks Discount";
export const QB_SHIPPING_NAME = "Shipping";

export interface MoneyLineInput {
  /** Clave del caller (índice, `order_line_item.id`…) — se devuelve tal cual. */
  key: string;
  /** Neto de la línea en cents (unit_price × qty, post descuento de línea). */
  net_cents: number;
  taxable: boolean;
}

export interface MoneyHeaderInput {
  discount_cents: number;
  shipping_cents: number;
  tax_cents: number;
  /** Total del header de QB — se cuadra contra Σ neto − desc + envío + tax. */
  total_cents: number;
}

export interface MoneyTaxLine {
  code: string;
  rate: number;
  description: string;
}

export interface MoneyLinePlan {
  key: string;
  net_cents: number;
  taxable: boolean;
  tax_line: MoneyTaxLine;
  /** Descuento asignado a esta línea, cents (0 = sin adjustment). */
  adjustment_cents: number;
}

export type RatePolicy = "none" | "statutory" | "effective";

export interface SalesOrderMoneyPlan {
  lines: MoneyLinePlan[];
  rate_policy: RatePolicy;
  tax_rate: number;
  taxable_base_cents: number;
  shipping: { name: string; amount_cents: number } | null;
  summary: {
    subtotal_cents: number;
    discount_cents: number;
    shipping_cents: number;
    tax_cents: number;
    total_cents: number;
  };
}

export type SalesOrderMoneyResult =
  | ({ ok: true } & SalesOrderMoneyPlan)
  | { ok: false; reason: "total_mismatch" | "tax_without_taxable_base" | "negative_line" | "discount_exceeds_lines"; detail: string };

/** `SalesTaxCodeRef` de QB → gravable. `Non` es la única forma de exento; ausente = gravable. */
export function isQbLineTaxable(salesTaxCodeName: string | null | undefined): boolean {
  return !/^non/i.test((salesTaxCodeName ?? "").trim());
}

export function taxLineFor(rate: number, policy: RatePolicy, taxable: boolean): MoneyTaxLine {
  if (!taxable || rate === 0) return { code: TAX_CODE_EXEMPT, rate: 0, description: TAX_DESC_EXEMPT };
  return { code: TAX_CODE_FL, rate, description: policy === "effective" ? TAX_DESC_FL_EFFECTIVE : TAX_DESC_FL };
}

/** Plan PURO: qué tax line, qué adjustment y qué shipping lleva cada orden. */
export function planSalesOrderMoney(lines: readonly MoneyLineInput[], header: MoneyHeaderInput): SalesOrderMoneyResult {
  for (const l of lines) {
    if (!Number.isInteger(l.net_cents) || l.net_cents < 0) {
      return { ok: false, reason: "negative_line", detail: `línea ${l.key}: neto ${l.net_cents}` };
    }
  }
  const subtotal = lines.reduce((s, l) => s + l.net_cents, 0);
  const computedTotal = subtotal - header.discount_cents + header.shipping_cents + header.tax_cents;
  if (computedTotal !== header.total_cents) {
    return { ok: false, reason: "total_mismatch", detail: `Σ ${subtotal} − ${header.discount_cents} + ${header.shipping_cents} + ${header.tax_cents} = ${computedTotal} ≠ ${header.total_cents}` };
  }

  // Descuento: misma asignación que el POS (fixed, proporcional, mayor resto).
  const alloc =
    header.discount_cents > 0
      ? allocateOrderDiscount(
          lines.map((l) => ({ itemId: l.key, netCents: l.net_cents, taxable: l.taxable })),
          { type: "fixed", value: header.discount_cents / 100 }
        )
      : null;
  if (alloc && alloc.totalCents !== header.discount_cents) {
    // `allocateOrderDiscount` topea en el neto: un descuento mayor que las
    // líneas no se puede representar como adjustments sin inventar plata.
    return { ok: false, reason: "discount_exceeds_lines", detail: `descuento ${header.discount_cents} sobre neto ${subtotal}: asignable ${alloc.totalCents}` };
  }
  const adjByKey = new Map<string, number>(alloc?.lines.map((a) => [a.itemId, a.adjustmentCents]) ?? []);

  // Base gravable = Σ (neto − adjustment) de las líneas gravadas.
  let taxableFlags = lines.map((l) => l.taxable);
  if (header.tax_cents > 0 && !taxableFlags.some(Boolean)) taxableFlags = lines.map(() => true);
  const baseOf = (flags: boolean[]) => lines.reduce((s, l, i) => (flags[i] ? s + l.net_cents - (adjByKey.get(l.key) ?? 0) : s), 0);
  const base = baseOf(taxableFlags);

  let policy: RatePolicy;
  let rate: number;
  if (header.tax_cents === 0) {
    policy = "none";
    rate = 0;
  } else if (base <= 0) {
    return { ok: false, reason: "tax_without_taxable_base", detail: `tax ${header.tax_cents} con base gravable ${base}` };
  } else if (Math.round(base * (FL_TAX_RATE / 100)) === header.tax_cents) {
    policy = "statutory";
    rate = FL_TAX_RATE;
  } else {
    policy = "effective";
    // 8 decimales: el error de `Σ base × tasa` queda muy por debajo del centavo.
    rate = Number(((header.tax_cents / base) * 100).toFixed(8));
  }

  return {
    ok: true,
    lines: lines.map((l, i) => ({
      key: l.key,
      net_cents: l.net_cents,
      taxable: policy === "none" ? false : taxableFlags[i]!,
      tax_line: taxLineFor(rate, policy, taxableFlags[i]!),
      adjustment_cents: adjByKey.get(l.key) ?? 0,
    })),
    rate_policy: policy,
    tax_rate: rate,
    taxable_base_cents: policy === "none" ? 0 : base,
    shipping: header.shipping_cents > 0 ? { name: QB_SHIPPING_NAME, amount_cents: header.shipping_cents } : null,
    summary: {
      subtotal_cents: subtotal,
      discount_cents: header.discount_cents,
      shipping_cents: header.shipping_cents,
      tax_cents: header.tax_cents,
      total_cents: header.total_cents,
    },
  };
}

/** Lo que Medusa acumula por sus propias reglas (`Σ (neto − adj) × tasa`), en cents sin redondear — para afirmar la política ±1¢. */
export function medusaTaxCents(plan: SalesOrderMoneyPlan): number {
  return plan.lines.reduce((s, l) => s + ((l.net_cents - l.adjustment_cents) * l.tax_line.rate) / 100, 0);
}

/** Forma que `createOrders` acepta en `items[].tax_lines` / `items[].adjustments` (dólares). */
export function toMedusaItemMoney(line: MoneyLinePlan): {
  tax_lines: Array<{ code: string; rate: number; description: string }>;
  adjustments: Array<{ code: string; amount: number; description: string }>;
} {
  return {
    tax_lines: [{ code: line.tax_line.code, rate: line.tax_line.rate, description: line.tax_line.description }],
    adjustments: line.adjustment_cents > 0 ? [{ code: QB_DISCOUNT_CODE, amount: line.adjustment_cents / 100, description: QB_DISCOUNT_DESC }] : [],
  };
}

/** BigNumber JSONB de Medusa para las columnas `raw_*`. */
export function raw20(n: number): string {
  return JSON.stringify({ value: String(n), precision: 20 });
}

// ── El único export con I/O: el parche del summary ───────────────────────────

export interface SummaryPatchDb {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * Escribe en `order_summary` (versión vigente) los centavos exactos de QB —
 * misma forma que `apply-order-discount.ts` / `convert-force`: `tax_total`,
 * `discount_total`, `accounting_total`, `current_order_total`,
 * `pending_difference` con sus `raw_*`. NO toca `order.metadata` (`pos_total`
 * ya es la verdad de QB). Dispara `trg_order_money_summary` →
 * `recompute_order_money` → `UPDATE "order"`: por eso el caller lo corre como
 * ÚLTIMO paso de la transacción del documento (ver `backdateOrder`).
 */
export async function patchOrderSummaryCents(db: SummaryPatchDb, orderId: string, s: SalesOrderMoneyPlan["summary"]): Promise<void> {
  const { rows } = await db.query(
    `SELECT id, totals FROM order_summary WHERE order_id = $1 AND deleted_at IS NULL ORDER BY version DESC LIMIT 1`,
    [orderId]
  );
  const row = rows[0];
  if (!row) throw new Error(`la orden ${orderId} no tiene order_summary`);
  const totals = (typeof row.totals === "string" ? JSON.parse(row.totals) : row.totals) as Record<string, unknown>;
  const tax = s.tax_cents / 100;
  const discount = s.discount_cents / 100;
  const total = s.total_cents / 100;
  await db.query(`UPDATE order_summary SET totals = $1, updated_at = NOW() WHERE id = $2`, [
    JSON.stringify({
      ...totals,
      discount_total: discount,
      raw_discount_total: { value: String(discount), precision: 20 },
      tax_total: tax,
      raw_tax_total: { value: String(tax), precision: 20 },
      accounting_total: total,
      raw_accounting_total: { value: String(total), precision: 20 },
      current_order_total: total,
      raw_current_order_total: { value: String(total), precision: 20 },
      pending_difference: total,
      raw_pending_difference: { value: String(total), precision: 20 },
    }),
    row.id,
  ]);
}

/** Header de `pos_invoice` (cents) → entrada del plan. */
export function headerFromPosInvoice(inv: { discount: unknown; shipping: unknown; tax: unknown; total: unknown }): MoneyHeaderInput {
  const c = (v: unknown) => Math.round(Number(v ?? 0));
  return { discount_cents: c(inv.discount), shipping_cents: c(inv.shipping), tax_cents: c(inv.tax), total_cents: c(inv.total) };
}

/** `patchOrderSummaryCents` con los cents de la `pos_invoice` viva de la orden (la verdad de QB ya en el POS). */
export async function patchOrderSummaryFromPosInvoice(db: SummaryPatchDb, orderId: string): Promise<void> {
  const { rows } = await db.query(
    `SELECT subtotal, discount, shipping, tax, total FROM pos_invoice WHERE order_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [orderId]
  );
  if (!rows[0]) throw new Error(`${orderId}: sin pos_invoice para parchear el summary`);
  const h = headerFromPosInvoice(rows[0] as { discount: unknown; shipping: unknown; tax: unknown; total: unknown });
  await patchOrderSummaryCents(db, orderId, { subtotal_cents: Math.round(Number(rows[0].subtotal ?? 0)), ...h });
}
