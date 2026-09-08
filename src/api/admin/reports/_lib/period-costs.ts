/**
 * period-costs.ts — la ÚNICA definición de "costos y gastos del período" para
 * los reportes Expenses y Profit & Loss.
 *
 * ## Qué es un costo del período acá
 *
 * Una plata que el POS originó y que QuickBooks lleva a una cuenta de
 * RESULTADOS (CostOfGoodsSold / Expense / OtherExpense) en la fecha del
 * documento, y que NO está ya dentro del costo promedio de los ítems. Tres
 * fuentes, cada una con su propia query (nunca un JOIN entre fuentes: reducir
 * cada lado a una fila por documento ANTES de juntar es lo que evita el
 * fan-out que ya costó $122,29 en by-item):
 *
 *   1. `vendor_bill` confirmed/synced, líneas `qb_account`, por `document_date`.
 *   2. Credit memos de write-off por fraude (`metadata.reporting_treatment`),
 *      identidad por ListID del ITEM y cuenta por ListID de la CUENTA
 *      (`lib/reports/fraud-writeoff.ts`), por `completed_at`.
 *   3. Ajustes de redondeo (`pos_rounding_adjustment`) — centavos, pero
 *      conciliables: van a cuentas Income de QB con signo.
 *
 * ## La regla de capitalización (lo que NO es gasto del período)
 *
 * El POS capitaliza flete de importación, comisión de agente de compra y
 * aranceles en el costo promedio del ítem; llegan al P&L como COGS al VENDER.
 * QuickBooks no capitaliza: los expensa al bill. Por eso un reporte de gastos
 * del POS tiene que excluir lo capitalizado, o el mismo dólar aparece dos veces
 * (una en COGS cuando se vende, otra como "gasto" cuando se billa). Se excluye:
 *
 *   - todo bill service/freight/tariff ATADO a una PO (`purchase_order_id`) o
 *     REFERENCIADO por un regular (`*_vendor_bill_id`): por construcción del
 *     confirm se prorratea en `landed_unit_cost_cents` de las líneas de producto.
 *     Medido en prod el 2026-09-08: 26/29 freight y 27/33 service son de éstos.
 *   - `line_kind='tax_charge'`: espejo local del impuesto de header, SIEMPRE
 *     capitalizado y nunca viaja a QB como línea de cuenta.
 *   - `line_kind='freight_charge'` cuando el regular tiene
 *     `freight_allocation_basis` (units|value|cbm): ahí el cargo se reparte en
 *     el landed cost. Con basis NULL es gasto puro (política legacy, ver el
 *     comentario del modelo `vendor-bill.ts`).
 *
 * Lo que queda son los bills standalone: comisión de venta por referido,
 * subcontratista de la orden, y los `expense` bills (tipo que existe desde
 * 2026-08-20 y en prod todavía no tiene ninguno).
 *
 * El caso borde que la regla estructural no resuelve sola: un service/freight
 * del AGENTE de China (Veetech) cuyo bill regular todavía está en draft (VB-1143
 * y VB-1144 en prod, 2026-09-01: el regular VB-1142 sin confirmar). No tiene PO
 * ni regular que lo referencie, así que "parece" gasto del período — pero es
 * landed cost esperando su enlace. Se reconoce por el flag estructural del
 * vendor (`qb_vendor.metadata.is_china_agent`), nunca por el nombre de la
 * cuenta, y va al bucket `pending_link`: visible, con importe, y FUERA de los
 * totales. Cuando el regular se confirma y lo enlaza, sale del reporte solo.
 *
 * ## Una fuente por dólar
 *
 * La comisión de venta liquidada y el subcontrato se pagan creando un vendor
 * bill `service` sin PO; el `commission_settlement` y el
 * `outsourced_service_settlement` son PUNTEROS a ese bill, no un segundo
 * importe. Acá cuenta el bill, siempre. `fetchSettledCommissionCentsForPeriod`
 * (base liquidación, por `settled_at`) sigue alimentando el tile de Sales y
 * sirve para conciliar; no alimenta estos reportes.
 *
 * ## Clasificación por tipo de cuenta
 *
 * El tipo sale del snapshot de la línea (`qb_account_type`, congelado al
 * crearla) y, si falta, del cache `qb_account` por ListID. Nunca por nombre.
 * Una línea sin tipo NO se descarta: va al bucket "Unclassified" y el reporte
 * se marca `incomplete` — un gasto que desaparece en silencio es exactamente
 * el bug que este módulo existe para evitar. Una cuenta de balance (Bank,
 * AccountsPayable, …) en una línea de bill tampoco se descarta a ciegas: se
 * suma en `excluded_balance_sheet_cents` para que se vea.
 *
 * Bindings: knex (`__pg_connection__`) usa `?`, no `$1`.
 */
import {
  FRAUD_WRITEOFF_QB_ACCOUNT,
  cmNotFraudWriteoffSql,
} from "../../../../lib/reports/fraud-writeoff"
import { CM_REFUND_CENTS_EXPR, CM_REFUND_DATE_COL } from "./sales-revenue"

type RawPg = {
  raw: (sql: string, bindings: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>
}

export const PNL_COST_ACCOUNT_TYPES = ["CostOfGoodsSold", "Expense", "OtherExpense"] as const
export const PNL_INCOME_ACCOUNT_TYPES = ["Income", "OtherIncome"] as const
export type PnlCostAccountType = (typeof PNL_COST_ACCOUNT_TYPES)[number]
export type PnlIncomeAccountType = (typeof PNL_INCOME_ACCOUNT_TYPES)[number]
export const UNCLASSIFIED_ACCOUNT_TYPE = "Unclassified"

export type PeriodCostSource = "vendor_bill" | "fraud_writeoff" | "rounding"
export type PeriodCostBucket = "cost" | "income" | "balance_sheet" | "unclassified" | "pending_link"

export interface PeriodCostLine {
  source: PeriodCostSource
  document_id: string
  document_number: string | null
  document_kind: "Vendor bill" | "Credit memo" | "Rounding adjustment"
  /** Instante ISO de la fecha contable del documento. */
  document_date: string
  counterparty: string | null
  account_list_id: string | null
  account_full_name: string | null
  account_type: string
  bucket: PeriodCostBucket
  /**
   * Centavos con signo contable: en `cost`, positivo = costo. En `income`,
   * positivo = ingreso (un shortage de caja va negativo).
   */
  amount_cents: number
  description: string | null
  document_status: string
  qb_synced: boolean
  qb_ref: string | null
  /** Ruta del POS para abrir el documento. */
  link_path: string
}

/** Fecha contable de un bill: la del documento del vendor, no la de carga. */
export const VENDOR_BILL_DATE_COL = `COALESCE(vb.document_date, vb.created_at)`

/**
 * Bills cuyas líneas de cuenta son gasto del período. Exportado (y no inlineado
 * en la query) para que `verify-period-costs.ts` pueda mutarlo y comprobar que
 * el verificador muerde. Alias fijos: `vb` (bill), `l` (línea).
 */
export const VENDOR_BILL_PERIOD_COST_SCOPE_SQL = `
     vb.deleted_at IS NULL
     AND vb.status IN ('confirmed', 'synced')
     AND l.deleted_at IS NULL
     AND l.line_type = 'qb_account'
     AND COALESCE(l.line_kind, '') <> 'tax_charge'
     AND NOT (COALESCE(l.line_kind, '') = 'freight_charge' AND vb.freight_allocation_basis IS NOT NULL)
     AND NOT (vb.bill_type IN ('service', 'freight', 'tariff') AND vb.purchase_order_id IS NOT NULL)
     AND NOT EXISTS (
       SELECT 1 FROM vendor_bill r
        WHERE r.deleted_at IS NULL
          AND (r.service_vendor_bill_id = vb.id
               OR r.freight_vendor_bill_id = vb.id
               OR r.tariff_vendor_bill_id = vb.id)
     )`

/**
 * Sibling del agente de China que todavía no fue enlazado por su bill regular:
 * landed cost en espera, no gasto del período. Alias fijos `vb` y `qv`
 * (`qb_vendor`). Se evalúa DESPUÉS del scope, o sea sólo sobre bills sin PO y
 * sin regular que los referencie.
 */
export const VENDOR_BILL_PENDING_LINK_SQL = `
     (vb.bill_type IN ('service', 'freight', 'tariff')
      AND COALESCE((qv.metadata->>'is_china_agent')::boolean, false))`

/**
 * Monto de una línea de cuenta. `amount_cents` es NULL en la mayoría de las
 * filas históricas (las de comisión y subcontrato usan qty × unit_cost), así
 * que leer sólo la columna reportaría $0 — misma trampa que documenta
 * `purchases/supply-chain`.
 */
export const VENDOR_BILL_LINE_CENTS = `COALESCE(l.amount_cents, ROUND(l.qty * l.unit_cost_cents))::bigint`

const COST_TYPES: ReadonlySet<string> = new Set(PNL_COST_ACCOUNT_TYPES)
const INCOME_TYPES: ReadonlySet<string> = new Set(PNL_INCOME_ACCOUNT_TYPES)

export function bucketForAccountType(accountType: string | null | undefined): PeriodCostBucket {
  const t = (accountType ?? "").trim()
  if (!t) return "unclassified"
  if (COST_TYPES.has(t)) return "cost"
  if (INCOME_TYPES.has(t)) return "income"
  return "balance_sheet"
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null
  return String(v)
}

function isoDate(v: unknown): string {
  if (v instanceof Date) return v.toISOString()
  const d = new Date(String(v))
  return isNaN(d.getTime()) ? String(v) : d.toISOString()
}

export async function fetchVendorBillPeriodCostLines(
  pg: RawPg,
  from: string,
  to: string
): Promise<PeriodCostLine[]> {
  const result = await pg.raw(
    `SELECT vb.id            AS document_id,
            vb.number        AS document_number,
            ${VENDOR_BILL_DATE_COL} AS document_date,
            vb.vendor_name_snapshot AS counterparty,
            vb.status        AS document_status,
            (vb.qb_txn_id IS NOT NULL) AS qb_synced,
            vb.qb_ref_number AS qb_ref,
            l.qb_account_list_id AS account_list_id,
            COALESCE(NULLIF(l.qb_account_full_name, ''), qa.full_name) AS account_full_name,
            COALESCE(NULLIF(l.qb_account_type, ''), qa.account_type)   AS account_type,
            ${VENDOR_BILL_LINE_CENTS} AS amount_cents,
            l.description,
            ${VENDOR_BILL_PENDING_LINK_SQL} AS pending_link
       FROM vendor_bill vb
       JOIN vendor_bill_line l ON l.vendor_bill_id = vb.id
       LEFT JOIN qb_account qa ON qa.qb_list_id = l.qb_account_list_id AND qa.deleted_at IS NULL
       LEFT JOIN qb_vendor qv ON qv.id = vb.vendor_id
      WHERE ${VENDOR_BILL_PERIOD_COST_SCOPE_SQL}
        AND ${VENDOR_BILL_DATE_COL} >= ?
        AND ${VENDOR_BILL_DATE_COL} <  ?
      ORDER BY ${VENDOR_BILL_DATE_COL}, vb.number, l.id`,
    [from, to]
  )
  return result.rows.map((r) => {
    const accountType = str(r.account_type) ?? ""
    return {
      source: "vendor_bill",
      document_id: String(r.document_id),
      document_number: str(r.document_number),
      document_kind: "Vendor bill",
      document_date: isoDate(r.document_date),
      counterparty: str(r.counterparty),
      account_list_id: str(r.account_list_id),
      account_full_name: str(r.account_full_name),
      account_type: accountType || UNCLASSIFIED_ACCOUNT_TYPE,
      bucket: r.pending_link === true ? "pending_link" : bucketForAccountType(accountType),
      amount_cents: Number(r.amount_cents ?? 0),
      description: str(r.description),
      document_status: String(r.document_status ?? ""),
      qb_synced: r.qb_synced === true,
      qb_ref: str(r.qb_ref),
      link_path: `/vendor-bills/${String(r.document_id)}`,
    }
  })
}

/**
 * Write-offs por fraude del período, uno por memo. Mismo scope, misma
 * expresión de monto y misma fecha que `fetchFraudWriteoffCentsForPeriod`
 * (sales-revenue.ts): es el complemento exacto de lo que Sales excluye de las
 * devoluciones, así que la plata no puede perderse entre las dos definiciones.
 */
export async function fetchFraudWriteoffLines(
  pg: RawPg,
  from: string,
  to: string
): Promise<PeriodCostLine[]> {
  const result = await pg.raw(
    `SELECT cm.id AS document_id,
            cm.credit_memo_number AS document_number,
            ${CM_REFUND_DATE_COL} AS document_date,
            COALESCE(NULLIF(TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')), ''), c.email) AS counterparty,
            cm.status AS document_status,
            (cm.qb_txn_id IS NOT NULL) AS qb_synced,
            ${CM_REFUND_CENTS_EXPR} AS amount_cents,
            cm.notes AS description
       FROM pos_credit_memo cm
       LEFT JOIN customer c ON c.id = cm.customer_id
      WHERE cm.deleted_at IS NULL
        AND cm.status = 'completed'
        AND NOT (${cmNotFraudWriteoffSql("cm")})
        AND ${CM_REFUND_DATE_COL} >= ?
        AND ${CM_REFUND_DATE_COL} <  ?
      ORDER BY ${CM_REFUND_DATE_COL}, cm.credit_memo_number`,
    [from, to]
  )
  return result.rows.map((r) => ({
    source: "fraud_writeoff",
    document_id: String(r.document_id),
    document_number: str(r.document_number),
    document_kind: "Credit memo",
    document_date: isoDate(r.document_date),
    counterparty: str(r.counterparty),
    account_list_id: FRAUD_WRITEOFF_QB_ACCOUNT.list_id,
    account_full_name: FRAUD_WRITEOFF_QB_ACCOUNT.full_name,
    account_type: FRAUD_WRITEOFF_QB_ACCOUNT.account_type,
    bucket: "cost",
    amount_cents: Number(r.amount_cents ?? 0),
    description: str(r.description),
    document_status: String(r.document_status ?? ""),
    qb_synced: r.qb_synced === true,
    qb_ref: null,
    link_path: `/returns/${String(r.document_id)}`,
  }))
}

/**
 * Ajustes de redondeo del período. Signo por dirección: un overage es ingreso
 * (+), un shortage lo resta (−). La cuenta (Income en QB) sale del cache por el
 * ListID congelado en la fila. Se cuenta por `created_at`: el asiento se emite
 * al aplicar el pago, no hay otra fecha contable.
 */
export async function fetchRoundingLines(
  pg: RawPg,
  from: string,
  to: string
): Promise<PeriodCostLine[]> {
  const result = await pg.raw(
    `SELECT ra.id AS document_id,
            ra.invoice_id,
            ra.created_at AS document_date,
            ra.direction,
            ra.amount_cents,
            ra.account_list_id,
            qa.full_name AS account_full_name,
            qa.account_type,
            ra.memo AS description,
            ra.qb_status AS document_status,
            (ra.qb_status = 'confirmed') AS qb_synced,
            i.invoice_number
       FROM pos_rounding_adjustment ra
       LEFT JOIN qb_account qa ON qa.qb_list_id = ra.account_list_id AND qa.deleted_at IS NULL
       LEFT JOIN pos_invoice i ON i.id = ra.invoice_id
      WHERE ra.deleted_at IS NULL
        AND ra.voided_at IS NULL
        AND ra.created_at >= ?
        AND ra.created_at <  ?
      ORDER BY ra.created_at`,
    [from, to]
  )
  return result.rows.map((r) => {
    const accountType = str(r.account_type) ?? ""
    const raw = Number(r.amount_cents ?? 0)
    const signed = String(r.direction) === "shortage" ? -Math.abs(raw) : Math.abs(raw)
    return {
      source: "rounding",
      document_id: String(r.document_id),
      document_number: str(r.invoice_number),
      document_kind: "Rounding adjustment",
      document_date: isoDate(r.document_date),
      counterparty: null,
      account_list_id: str(r.account_list_id),
      account_full_name: str(r.account_full_name),
      account_type: accountType || UNCLASSIFIED_ACCOUNT_TYPE,
      bucket: bucketForAccountType(accountType),
      amount_cents: signed,
      description: str(r.description),
      document_status: String(r.document_status ?? ""),
      qb_synced: r.qb_synced === true,
      qb_ref: null,
      link_path: r.invoice_id ? `/invoices/${String(r.invoice_id)}` : "/payments",
    }
  })
}

/** Las tres fuentes, cada una con su query, concatenadas. */
export async function fetchPeriodCostLines(
  pg: RawPg,
  from: string,
  to: string
): Promise<PeriodCostLine[]> {
  const [bills, fraud, rounding] = await Promise.all([
    fetchVendorBillPeriodCostLines(pg, from, to),
    fetchFraudWriteoffLines(pg, from, to),
    fetchRoundingLines(pg, from, to),
  ])
  return [...bills, ...fraud, ...rounding]
}

export interface PeriodCostAccountRow {
  account_list_id: string | null
  account_full_name: string | null
  account_type: string
  bucket: PeriodCostBucket
  cents: number
  documents: number
}

export interface PeriodCostSummary {
  /** Costos por tipo de cuenta de resultados (sólo bucket `cost`). */
  cost_cents_by_type: Record<PnlCostAccountType, number>
  cost_cents: number
  /** Ingresos por tipo (bucket `income`: hoy sólo redondeo). */
  income_cents_by_type: Record<PnlIncomeAccountType, number>
  income_cents: number
  unclassified_cents: number
  excluded_balance_sheet_cents: number
  /** Landed cost del agente esperando su bill regular: visible, fuera de los totales. */
  pending_link_cents: number
  /** true cuando hay plata sin tipo de cuenta: el total NO está completo. */
  incomplete: boolean
  accounts: PeriodCostAccountRow[]
  line_count: number
}

/** Agrupa por cuenta (ListID; sin ListID, por nombre) contando documentos distintos. Puro. */
export function summarizePeriodCosts(lines: readonly PeriodCostLine[]): PeriodCostSummary {
  const byAccount = new Map<string, PeriodCostAccountRow & { docs: Set<string> }>()
  const costByType: Record<PnlCostAccountType, number> = {
    CostOfGoodsSold: 0,
    Expense: 0,
    OtherExpense: 0,
  }
  const incomeByType: Record<PnlIncomeAccountType, number> = { Income: 0, OtherIncome: 0 }
  let unclassified = 0
  let balance = 0
  let pendingLink = 0

  for (const line of lines) {
    const key = `${line.bucket}|${line.account_list_id ?? `name:${line.account_full_name ?? ""}`}`
    const row =
      byAccount.get(key) ??
      {
        account_list_id: line.account_list_id,
        account_full_name: line.account_full_name,
        account_type: line.account_type,
        bucket: line.bucket,
        cents: 0,
        documents: 0,
        docs: new Set<string>(),
      }
    row.cents += line.amount_cents
    row.docs.add(`${line.source}:${line.document_id}`)
    byAccount.set(key, row)

    switch (line.bucket) {
      case "cost":
        costByType[line.account_type as PnlCostAccountType] += line.amount_cents
        break
      case "income":
        incomeByType[line.account_type as PnlIncomeAccountType] += line.amount_cents
        break
      case "unclassified":
        unclassified += line.amount_cents
        break
      case "balance_sheet":
        balance += line.amount_cents
        break
      case "pending_link":
        pendingLink += line.amount_cents
        break
    }
  }

  const accounts = [...byAccount.values()]
    .map(({ docs, ...row }) => ({ ...row, documents: docs.size }))
    .sort((a, b) => {
      if (a.bucket !== b.bucket) return a.bucket.localeCompare(b.bucket)
      if (a.account_type !== b.account_type) return a.account_type.localeCompare(b.account_type)
      return Math.abs(b.cents) - Math.abs(a.cents)
    })

  return {
    cost_cents_by_type: costByType,
    cost_cents: costByType.CostOfGoodsSold + costByType.Expense + costByType.OtherExpense,
    income_cents_by_type: incomeByType,
    income_cents: incomeByType.Income + incomeByType.OtherIncome,
    unclassified_cents: unclassified,
    excluded_balance_sheet_cents: balance,
    pending_link_cents: pendingLink,
    incomplete: unclassified !== 0,
    accounts,
    line_count: lines.length,
  }
}

// ── Compromisos pendientes ────────────────────────────────────────────────────

export interface PendingCommitment {
  kind: "outsourced_service" | "sales_commission"
  id: string
  display_number: string | null
  order_id: string | null
  state: string
  counterparty: string | null
  account_full_name: string | null
  amount_cents: number
  approved_at: string | null
  /** Bill de liquidación vinculado por el settlement, si existe. */
  settlement_bill_number: string | null
  settlement_bill_status: string | null
  link_path: string
}

/**
 * Lo aprobado que todavía no es un documento contable realizado. Informativo:
 * NUNCA se suma al P&L ni a Expenses. Un compromiso cuyo settlement ya apunta
 * a un bill confirmed/synced deja de ser compromiso (ese bill ya cuenta arriba).
 *
 * Límite honesto: el vínculo compromiso→bill existe SÓLO vía settlement. Un
 * bill de comisión creado a mano sin cerrar el settlement (VB-1148 en prod,
 * 2026-09-08) aparece acá como pendiente aunque el bill exista — se muestra el
 * dato, no se adivina el match por vendor y monto.
 */
export async function fetchPendingCommitments(pg: RawPg): Promise<PendingCommitment[]> {
  const [osv, comm] = await Promise.all([
    pg.raw(
      `SELECT s.id, s.display_number, s.order_id, s.state, s.vendor_display_name AS counterparty,
              s.qb_account_full_name AS account_full_name, s.amount_cents, s.approved_at,
              vb.number AS bill_number, vb.status AS bill_status
         FROM order_outsourced_service s
         LEFT JOIN LATERAL (
           SELECT vb.number, vb.status
             FROM outsourced_service_settlement st
             JOIN vendor_bill vb ON vb.id = st.vendor_bill_id AND vb.deleted_at IS NULL
            WHERE st.service_id = s.id AND st.status <> 'reversed'
            ORDER BY st.created_at DESC LIMIT 1
         ) vb ON TRUE
        WHERE s.deleted_at IS NULL
          AND s.state IN ('approved', 'settling')
          AND COALESCE(vb.status, '') NOT IN ('confirmed', 'synced')
        ORDER BY s.approved_at NULLS LAST, s.display_number`,
      []
    ),
    pg.raw(
      `SELECT r.id, oc.display_number, oc.order_id, r.state, r.display_name AS counterparty,
              r.amount_cents, r.approved_at,
              vb.number AS bill_number, vb.status AS bill_status
         FROM order_commission_recipient r
         JOIN order_commission oc ON oc.id = r.order_commission_id AND oc.deleted_at IS NULL
         LEFT JOIN LATERAL (
           SELECT vb.number, vb.status
             FROM commission_settlement st
             JOIN vendor_bill vb ON vb.id = st.vendor_bill_id AND vb.deleted_at IS NULL
            WHERE st.recipient_id = r.id AND st.status <> 'reversed'
            ORDER BY st.created_at DESC LIMIT 1
         ) vb ON TRUE
        WHERE r.deleted_at IS NULL
          AND r.state IN ('approved', 'settling')
          AND COALESCE(vb.status, '') NOT IN ('confirmed', 'synced')
        ORDER BY r.approved_at NULLS LAST, oc.display_number`,
      []
    ),
  ])

  const out: PendingCommitment[] = []
  for (const r of osv.rows) {
    out.push({
      kind: "outsourced_service",
      id: String(r.id),
      display_number: r.display_number != null ? `OSV-${String(r.display_number)}` : null,
      order_id: str(r.order_id),
      state: String(r.state ?? ""),
      counterparty: str(r.counterparty),
      account_full_name: str(r.account_full_name),
      amount_cents: Number(r.amount_cents ?? 0),
      approved_at: r.approved_at ? isoDate(r.approved_at) : null,
      settlement_bill_number: str(r.bill_number),
      settlement_bill_status: str(r.bill_status),
      link_path: r.order_id ? `/orders/${String(r.order_id)}` : "/orders",
    })
  }
  for (const r of comm.rows) {
    out.push({
      kind: "sales_commission",
      id: String(r.id),
      display_number: r.display_number != null ? `COM-${String(r.display_number)}` : null,
      order_id: str(r.order_id),
      state: String(r.state ?? ""),
      counterparty: str(r.counterparty),
      account_full_name: null,
      amount_cents: Number(r.amount_cents ?? 0),
      approved_at: r.approved_at ? isoDate(r.approved_at) : null,
      settlement_bill_number: str(r.bill_number),
      settlement_bill_status: str(r.bill_status),
      link_path: r.order_id ? `/orders/${String(r.order_id)}` : "/orders",
    })
  }
  return out
}
