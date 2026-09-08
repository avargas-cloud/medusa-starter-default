/**
 * GET /admin/reports/expenses/summary?from&to
 *
 * Costos y gastos del período por cuenta de QuickBooks, SIN el costo de los
 * productos vendidos y sin lo capitalizado en el costo promedio. Definición
 * única en `_lib/period-costs.ts` (la misma que usa el P&L).
 *
 * Devuelve dólares, como el resto de `reports/`. El período anterior es la
 * ventana espejo (`priorPeriod`), igual que `sales/summary`.
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import { parseDateRange, priorPeriod } from "../../_lib/date-range"
import {
  type PeriodCostAccountRow,
  type PeriodCostSummary,
  fetchPeriodCostLines,
  summarizePeriodCosts,
} from "../../_lib/period-costs"

const dollars = (c: number): number => Math.round(c) / 100

interface AccountOut {
  key: string
  account_list_id: string | null
  account_full_name: string | null
  account_type: string
  bucket: string
  amount: number
  prior_amount: number
  documents: number
}

const accountKey = (r: PeriodCostAccountRow): string =>
  `${r.bucket}|${r.account_list_id ?? `name:${r.account_full_name ?? ""}`}`

function totalsOut(s: PeriodCostSummary) {
  return {
    cost_by_type: {
      CostOfGoodsSold: dollars(s.cost_cents_by_type.CostOfGoodsSold),
      Expense: dollars(s.cost_cents_by_type.Expense),
      OtherExpense: dollars(s.cost_cents_by_type.OtherExpense),
    },
    cost_total: dollars(s.cost_cents),
    income_total: dollars(s.income_cents),
    unclassified: dollars(s.unclassified_cents),
    excluded_balance_sheet: dollars(s.excluded_balance_sheet_cents),
    pending_link: dollars(s.pending_link_cents),
    incomplete: s.incomplete,
    line_count: s.line_count,
  }
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const range = parseDateRange(req)
  if (!range) return res.status(400).json({ error: "from and to are required" })
  const prior = priorPeriod(range)
  const pg = req.scope.resolve("__pg_connection__") as any

  try {
    const [currLines, prevLines] = await Promise.all([
      fetchPeriodCostLines(pg, range.from, range.to),
      fetchPeriodCostLines(pg, prior.from, prior.to),
    ])
    const curr = summarizePeriodCosts(currLines)
    const prev = summarizePeriodCosts(prevLines)

    const prevByKey = new Map(prev.accounts.map((r) => [accountKey(r), r]))
    const accounts: AccountOut[] = curr.accounts.map((r) => ({
      key: accountKey(r),
      account_list_id: r.account_list_id,
      account_full_name: r.account_full_name,
      account_type: r.account_type,
      bucket: r.bucket,
      amount: dollars(r.cents),
      prior_amount: dollars(prevByKey.get(accountKey(r))?.cents ?? 0),
      documents: r.documents,
    }))
    // Cuentas que sólo existen en el período anterior: se listan en 0 para que
    // la variación no las esconda.
    const currKeys = new Set(accounts.map((a) => a.key))
    for (const r of prev.accounts) {
      const k = accountKey(r)
      if (currKeys.has(k)) continue
      accounts.push({
        key: k,
        account_list_id: r.account_list_id,
        account_full_name: r.account_full_name,
        account_type: r.account_type,
        bucket: r.bucket,
        amount: 0,
        prior_amount: dollars(r.cents),
        documents: 0,
      })
    }

    return res.json({
      from: range.from,
      to: range.to,
      prior: { from: prior.from, to: prior.to, totals: totalsOut(prev) },
      totals: totalsOut(curr),
      accounts,
    })
  } catch (e: any) {
    return res.status(500).json({ error: e.message })
  }
}
