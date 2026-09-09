/**
 * pnl-statement.ts — arma el Profit & Loss del POS con la estructura de
 * QuickBooks (Income · COGS · Gross Profit · Expense · Net Operating Income ·
 * Other · Net Income) sobre la base ECONÓMICA del POS.
 *
 * Una sola definición de cada número: ingreso, devoluciones, flete y COGS de
 * producto salen de los mismos helpers que `sales/summary` y month-close
 * (`sales-revenue.ts`, `cogs-join.ts`, `shipping-revenue.ts`); los costos del
 * período salen de `period-costs.ts`, el mismo módulo que alimenta Expenses.
 * Por eso Expenses y P&L no pueden discrepar entre sí, y el verificador
 * `verify-period-costs.ts` afirma que el COGS de producto de acá es el de Sales.
 *
 * ## Dos "gross profit", una sola definición
 *
 * Sales llama Gross Profit a `net revenue − COGS de producto`. QuickBooks lleva
 * comisiones de venta, subcontratos y flete suelto DENTRO de COGS, así que su
 * Gross Profit es más chico. Acá el Gross Profit es el de QuickBooks (contabilidad
 * concilia contra eso), y el de Sales se expone como la línea puente
 * `product_margin`, con el mismo cálculo que siempre tuvo. No hay dos modos.
 *
 * ## Base y timing — lo que hay que declarar en pantalla
 *
 * - El POS capitaliza flete de importación, comisión de agente y aranceles en
 *   el costo promedio; QuickBooks los expensa al bill. Diferencia de importe y
 *   de período por diseño (`period-costs.ts`).
 * - Comisiones de venta: acá por `document_date` del bill; el tile de Sales
 *   usa la fecha de liquidación. `memo.commission_settled_basis` trae ese otro
 *   número para conciliar.
 * - Defectuosos: el POS deja el costo de la unidad dañada dentro del COGS de
 *   la venta (no lo revierte); QuickBooks lo mueve a `Damaged Goods`, que es
 *   subcuenta de COGS. Mismo total de sección, distinta línea:
 *   `memo.damaged_returns_cost_retained_in_cogs` lo muestra sin sumarlo.
 * - Surcharge de tarjeta: excluido, pendiente de conciliación contable.
 * - Gastos bancarios directos: sólo líneas de asientos explícitamente posteados;
 *   reversas reconocidas en su propia fecha, nunca drafts ni revisión diaria.
 *
 * Bindings knex `?`. Todo lo que devuelve va en DÓLARES (como Sales); los
 * centavos se convierten al final, nunca a mitad de una suma.
 */
import { avgCostDollars } from "../../../../lib/cost/cost-sql"
import { cmNotFraudWriteoffSql } from "../../../../lib/reports/fraud-writeoff"
import { COGS_JOIN, COST_DOLLARS, fetchReturnedProductCostDollars } from "./cogs-join"
import { fetchSettledCommissionCentsForPeriod } from "./commission-expr"
import { PAYROLL_LINE_KEY, PAYROLL_LINE_LABEL, fetchRecognizedPayrollCents } from "./monthly-payroll"
import type { DateRange } from "./date-range"
import {
  type PeriodCostAccountRow,
  type PeriodCostLine,
  fetchPeriodCostLines,
  summarizePeriodCosts,
} from "./period-costs"
import {
  NET_ITEM_REVENUE,
  SALES_ACTIVE_STATUSES_SQL,
  SALES_DATE_FILTER_SQL,
  fetchCmRefundsCentsForPeriod,
} from "./sales-revenue"
import { fetchShippingCentsForPeriod } from "./shipping-revenue"

type RawPg = {
  raw: (sql: string, bindings: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>
}

export interface PnlLine {
  key: string
  label: string
  /** Dólares, con el signo con el que entra a la sección (una devolución es negativa en Income). */
  amount: number
  account_list_id?: string | null
  account_type?: string
  documents?: number
}

export interface PnlSection {
  label: string
  lines: PnlLine[]
  total: number
}

export interface PnlStatement {
  from: string
  to: string
  invoice_count: number
  income: PnlSection
  cogs: PnlSection
  /** Puente: el "Gross Profit" de Sales (net revenue − COGS de producto). */
  product_margin: number
  gross_profit: number
  gross_margin_pct: number
  expense: PnlSection
  net_operating_income: number
  other: PnlSection
  net_income: number
  memo: {
    damaged_returns_cost_retained_in_cogs: number
    commission_settled_basis: number
    unclassified: number
    excluded_balance_sheet: number
    /** Siblings del agente de China sin enlazar: landed cost en espera, no sumado. */
    pending_link: number
    /** Nómina MANUAL reconocida en el período (ya sumada en Expense); nunca viene de QB. */
    payroll_manual: number
    incomplete: boolean
    surcharge_excluded: true
  }
}

const cents = (v: unknown): number => Number(v ?? 0)
const dollars = (c: number): number => Math.round(c) / 100
const round2 = (d: number): number => Math.round(d * 100) / 100

/**
 * Espejo de `fetchPeriodStats` de `sales/summary` (ingreso neto + COGS de
 * producto sobre las mismas líneas). El COGS se toma como numeric exacto:
 * Sales lo castea a bigint (dólares enteros), y ese redondeo no se hereda.
 * ATAJO: SQL duplicado de sales/summary/route.ts, disparador: al tocar esa
 * ruta mover fetchPeriodStats a _lib e importarlo desde los dos lados.
 */
async function fetchSalesCore(pg: RawPg, from: string, to: string) {
  const result = await pg.raw(
    `SELECT COUNT(DISTINCT i.id)::int                    AS invoice_count,
            COALESCE(SUM(${NET_ITEM_REVENUE}), 0)::bigint AS revenue_cents,
            COALESCE(SUM(${COST_DOLLARS}), 0)::numeric    AS cogs_dollars
       FROM pos_invoice i
       JOIN pos_invoice_item pii ON pii.invoice_id = i.id AND pii.deleted_at IS NULL
       ${COGS_JOIN}
      WHERE i.deleted_at IS NULL AND ${SALES_ACTIVE_STATUSES_SQL}
        AND ${SALES_DATE_FILTER_SQL}`,
    [from, to]
  )
  const r = result.rows[0] ?? {}
  return {
    invoiceCount: Number(r.invoice_count ?? 0),
    revenueCents: cents(r.revenue_cents),
    cogsDollars: Number(r.cogs_dollars ?? 0),
  }
}

/**
 * Ajustes de conteo de inventario aplicados en la ventana, mismo filtro y
 * misma convención de signo que `sales/summary` (delta>0 = write-up = COGS
 * positivo). ATAJO: duplicado de fetchInventoryAdjCogs, mismo disparador.
 */
async function fetchInventoryAdjCogsDollars(pg: RawPg, from: string, to: string): Promise<number> {
  const result = await pg.raw(
    `SELECT COALESCE(SUM(
       icl.delta_applied::numeric * COALESCE(${avgCostDollars("pv")}, 0)
     ), 0) AS adj_cogs
     FROM inventory_count ic
     JOIN inventory_count_line icl ON icl.inventory_count_id = ic.id
       AND icl.deleted_at IS NULL
       AND icl.status IN ('applied', 'overridden') AND icl.delta_applied != 0
     LEFT JOIN product_variant pv ON pv.id = icl.product_variant_id
     WHERE ic.deleted_at IS NULL AND ic.voided_at IS NULL
       AND ic.status IN ('approved', 'partially_applied')
       AND ic.applied_at >= ? AND ic.applied_at < ?`,
    [from, to]
  )
  return Number(result.rows[0]?.adj_cogs ?? 0)
}

/**
 * Costo de las unidades devueltas DAÑADAS en la ventana. Es la parte que
 * `fetchReturnedProductCostDollars` deja adentro del COGS a propósito
 * (GREATEST(0, quantity − damaged_qty)); acá se mide para MOSTRARLA, no para
 * sumarla — ya está en el COGS de producto.
 */
async function fetchDamagedReturnsCostDollars(pg: RawPg, from: string, to: string): Promise<number> {
  const result = await pg.raw(
    `SELECT COALESCE(SUM(
       COALESCE(cmi.average_unit_cost, ${avgCostDollars("pv")}, 0)
       * COALESCE(cmi.damaged_qty, 0)
     ), 0) AS cost
     FROM pos_credit_memo cm
     JOIN pos_credit_memo_item cmi ON cmi.credit_memo_id = cm.id AND cmi.deleted_at IS NULL
     LEFT JOIN product_variant pv ON pv.id = cmi.variant_id AND pv.deleted_at IS NULL
     WHERE cm.deleted_at IS NULL AND cm.voided_at IS NULL AND cm.status = 'completed'
       AND ${cmNotFraudWriteoffSql("cm")}
       AND COALESCE(cm.completed_at, cm.created_at) >= ?
       AND COALESCE(cm.completed_at, cm.created_at) <  ?`,
    [from, to]
  )
  return Number(result.rows[0]?.cost ?? 0)
}

/**
 * Líneas de una sección por tipo de cuenta. Filtra TAMBIÉN por bucket: una
 * fila `pending_link` conserva su tipo de cuenta (COGS) y sin este filtro se
 * colaría en la sección — el bucket es lo que la deja fuera de los totales.
 */
function accountLines(
  rows: readonly PeriodCostAccountRow[],
  accountType: string,
  prefix: string
): PnlLine[] {
  const bucket = accountType === "Income" || accountType === "OtherIncome" ? "income" : "cost"
  return rows
    .filter((r) => r.bucket === bucket && r.account_type === accountType)
    .map((r) => ({
      key: `${prefix}:${r.account_list_id ?? r.account_full_name ?? "unknown"}`,
      label: r.account_full_name ?? "(sin nombre de cuenta)",
      amount: dollars(r.cents),
      account_list_id: r.account_list_id,
      account_type: r.account_type,
      documents: r.documents,
    }))
}

const sumLines = (lines: readonly PnlLine[]): number => round2(lines.reduce((s, l) => s + l.amount, 0))

export async function buildPnlStatementForRange(pg: RawPg, range: DateRange): Promise<PnlStatement> {
  const { from, to } = range
  const [core, shippingCents, refundCents, returnedCostDollars, adjCogsDollars, damagedDollars, commissionSettledCents, costLines, payrollCents] =
    await Promise.all([
      fetchSalesCore(pg, from, to),
      fetchShippingCentsForPeriod(pg, from, to),
      fetchCmRefundsCentsForPeriod(pg, from, to),
      fetchReturnedProductCostDollars(pg, from, to),
      fetchInventoryAdjCogsDollars(pg, from, to),
      fetchDamagedReturnsCostDollars(pg, from, to),
      fetchSettledCommissionCentsForPeriod(pg, from, to),
      fetchPeriodCostLines(pg, from, to),
      fetchRecognizedPayrollCents(pg, from, to),
    ])
  return assemble(range, core, shippingCents, refundCents, returnedCostDollars, adjCogsDollars, damagedDollars, commissionSettledCents, costLines, payrollCents)
}

/** Puro: separa el ensamblado de las queries para que el verificador lo pruebe con fixtures. */
export function assemble(
  range: DateRange,
  core: { invoiceCount: number; revenueCents: number; cogsDollars: number },
  shippingCents: number,
  refundCents: number,
  returnedCostDollars: number,
  adjCogsDollars: number,
  damagedDollars: number,
  commissionSettledCents: number,
  costLines: readonly PeriodCostLine[],
  /** Nómina manual reconocida en el período (mitad el 15, mitad a fin de mes). */
  payrollCents = 0
): PnlStatement {
  const costs = summarizePeriodCosts(costLines)

  const incomeLines: PnlLine[] = [
    { key: "sales", label: "Sales (net of discounts)", amount: dollars(core.revenueCents) },
    { key: "shipping", label: "Shipping & handling income", amount: dollars(shippingCents) },
    { key: "returns", label: "Returns (credit memos)", amount: -dollars(refundCents) },
    ...accountLines(costs.accounts, "Income", "income"),
  ]
  const income: PnlSection = { label: "Income", lines: incomeLines, total: sumLines(incomeLines) }

  const productCogs = round2(core.cogsDollars)
  const returnedCost = round2(returnedCostDollars)
  const adjCogs = round2(adjCogsDollars)
  const cogsLines: PnlLine[] = [
    { key: "product_cogs", label: "Cost of goods sold (landed average cost)", amount: productCogs },
    { key: "returned_cost", label: "Cost recovered on returns (restocked)", amount: -returnedCost },
    { key: "inventory_adjustments", label: "Inventory count adjustments", amount: adjCogs },
    ...accountLines(costs.accounts, "CostOfGoodsSold", "cogs"),
  ]
  const cogs: PnlSection = { label: "Cost of Goods Sold", lines: cogsLines, total: sumLines(cogsLines) }

  // Puente: exactamente el gross_profit de sales/summary (net revenue − COGS
  // neto de producto), sin los costos directos del período.
  const netRevenueSales = round2(dollars(core.revenueCents + shippingCents - refundCents))
  const productMargin = round2(netRevenueSales - (productCogs + adjCogs - returnedCost))

  const grossProfit = round2(income.total - cogs.total)

  // La nómina no tiene documento ni cuenta: es una línea PROPIA de Expense
  // (sin `account_list_id`, como las de producto en COGS), así el gate que
  // cruza Expenses contra las líneas de cuenta del P&L no la cuenta dos veces.
  const expenseLines: PnlLine[] = [
    ...accountLines(costs.accounts, "Expense", "expense"),
    ...(payrollCents > 0
      ? [{ key: PAYROLL_LINE_KEY, label: PAYROLL_LINE_LABEL, amount: dollars(payrollCents) }]
      : []),
  ]
  const expense: PnlSection = { label: "Expense", lines: expenseLines, total: sumLines(expenseLines) }
  const netOperatingIncome = round2(grossProfit - expense.total)

  const otherIncome = accountLines(costs.accounts, "OtherIncome", "other_income")
  const otherExpense = accountLines(costs.accounts, "OtherExpense", "other_expense").map((l) => ({
    ...l,
    amount: -l.amount,
  }))
  const otherLines = [...otherIncome, ...otherExpense]
  const other: PnlSection = { label: "Other Income / Expense", lines: otherLines, total: sumLines(otherLines) }

  const netIncome = round2(netOperatingIncome + other.total)

  return {
    from: range.from,
    to: range.to,
    invoice_count: core.invoiceCount,
    income,
    cogs,
    product_margin: productMargin,
    gross_profit: grossProfit,
    gross_margin_pct: income.total > 0 ? Math.round((grossProfit / income.total) * 1000) / 10 : 0,
    expense,
    net_operating_income: netOperatingIncome,
    other,
    net_income: netIncome,
    memo: {
      damaged_returns_cost_retained_in_cogs: round2(damagedDollars),
      commission_settled_basis: dollars(commissionSettledCents),
      unclassified: dollars(costs.unclassified_cents),
      excluded_balance_sheet: dollars(costs.excluded_balance_sheet_cents),
      pending_link: dollars(costs.pending_link_cents),
      payroll_manual: dollars(payrollCents),
      incomplete: costs.incomplete,
      surcharge_excluded: true,
    },
  }
}
