/**
 * gl-parity-report.ts — gl-core-v1 fase 5 §8. Paridad mensual GL ↔ reporte POS.
 *
 * Compara, mes a mes, el Income neto que arroja el journal (`bank_journal_line`
 * de la familia `document`) contra el "net revenue" que ya calculan los
 * reportes de ventas (`_lib/sales-revenue.ts` + `_lib/shipping-revenue.ts`),
 * usando EXACTAMENTE las mismas expresiones SQL — no una reimplementación.
 *
 *   DATABASE_URL=<sandbox> ./node_modules/.bin/tsx src/scripts/ledger/gl-parity-report.ts
 */
import { Pool } from "pg";

import { etMidnightUtc } from "../../lib/date/et";
import { cmNotFraudWriteoffSql } from "../../lib/reports/fraud-writeoff";
import {
  CM_REFUND_CENTS_EXPR,
  CM_REFUND_DATE_COL,
  CM_REFUND_SCOPE_SQL,
  NET_ITEM_REVENUE,
  SALES_ACTIVE_STATUSES_SQL,
  SALES_DATE_FILTER_SQL,
} from "../../api/admin/reports/_lib/sales-revenue";
import { fetchShippingCentsForPeriod } from "../../api/admin/reports/_lib/shipping-revenue";

/** `pg.raw(sql, bindings)` con `?` (convención knex) → `pool.query` con `$1..$n`. */
function pgAdapter(pool: Pool) {
  return {
    raw: async (sql: string, bindings: unknown[]) => {
      let i = 0;
      const converted = sql.replace(/\?/g, () => `$${++i}`);
      return pool.query(converted, bindings);
    },
  };
}

type MonthWindow = { label: string; fromIso: string; toIso: string; fromDay: string; toDay: string };

/** Ventanas del reporte: abril desde el go-live (14), mayo→agosto completos. */
function monthWindows(): MonthWindow[] {
  const months: MonthWindow[] = [];
  const specs: [number, number, number][] = [
    [2026, 3, 14], // abril, desde el 14 (monthIndex 0-based)
    [2026, 4, 1],
    [2026, 5, 1],
    [2026, 6, 1],
    [2026, 7, 1],
  ];
  for (const [y, m, d] of specs) {
    const from = etMidnightUtc(y, m, d);
    const to = etMidnightUtc(y, m + 1, 1);
    const label = `${y}-${String(m + 1).padStart(2, "0")}`;
    months.push({
      label,
      fromIso: from.toISOString(),
      toIso: to.toISOString(),
      fromDay: `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
      toDay: `${to.getUTCFullYear()}-${String(to.getUTCMonth() + 1).padStart(2, "0")}-${String(
        to.getUTCDate()
      ).padStart(2, "0")}`,
    });
  }
  return months;
}

async function glIncomeNetCents(pool: Pool, fromDay: string, toDay: string): Promise<bigint> {
  const { rows } = await pool.query<{ net: string }>(
    `SELECT COALESCE(SUM(l.credit_cents - l.debit_cents), 0)::bigint AS net
       FROM bank_journal_line l
       JOIN bank_journal_entry e ON e.id = l.entry_id
      WHERE e.source_kind IS NOT NULL
        AND e.kind IN ('document', 'reversal')
        AND l.account_snapshot->>'account_type' = 'Income'
        AND e.day >= $1 AND e.day < $2`,
    [fromDay, toDay]
  );
  return BigInt(rows[0]?.net ?? "0");
}

async function glAccountTypeMovement(
  pool: Pool,
  fromDay: string,
  toDay: string,
  accountType: string
): Promise<{ debit: bigint; credit: bigint }> {
  const { rows } = await pool.query<{ debit: string; credit: string }>(
    `SELECT COALESCE(SUM(l.debit_cents), 0)::bigint AS debit,
            COALESCE(SUM(l.credit_cents), 0)::bigint AS credit
       FROM bank_journal_line l
       JOIN bank_journal_entry e ON e.id = l.entry_id
      WHERE e.source_kind IS NOT NULL
        AND e.kind IN ('document', 'reversal')
        AND l.account_snapshot->>'account_type' = $3
        AND e.day >= $1 AND e.day < $2`,
    [fromDay, toDay, accountType]
  );
  return { debit: BigInt(rows[0]?.debit ?? "0"), credit: BigInt(rows[0]?.credit ?? "0") };
}

async function glArClosingBalanceCents(pool: Pool, toDay: string): Promise<bigint> {
  const { rows } = await pool.query<{ debit: string; credit: string }>(
    `SELECT COALESCE(SUM(l.debit_cents), 0)::bigint AS debit,
            COALESCE(SUM(l.credit_cents), 0)::bigint AS credit
       FROM bank_journal_line l
       JOIN bank_journal_entry e ON e.id = l.entry_id
      WHERE e.source_kind IS NOT NULL
        AND e.kind IN ('document', 'reversal')
        AND l.role = 'accounts_receivable'
        AND e.day < $1`,
    [toDay]
  );
  return BigInt(rows[0]?.debit ?? "0") - BigInt(rows[0]?.credit ?? "0");
}

async function posNetItemRevenueCents(pg: ReturnType<typeof pgAdapter>, from: string, to: string): Promise<number> {
  const result = await pg.raw(
    `SELECT COALESCE(SUM(${NET_ITEM_REVENUE}), 0)::bigint AS revenue
       FROM pos_invoice i
       JOIN pos_invoice_item pii ON pii.invoice_id = i.id AND pii.deleted_at IS NULL
      WHERE i.deleted_at IS NULL AND ${SALES_ACTIVE_STATUSES_SQL}
        AND ${SALES_DATE_FILTER_SQL}`,
    [from, to]
  );
  return Number(result.rows[0]?.revenue ?? 0);
}

async function posCmRefundCents(pg: ReturnType<typeof pgAdapter>, from: string, to: string): Promise<number> {
  const result = await pg.raw(
    `SELECT COALESCE(SUM(${CM_REFUND_CENTS_EXPR}), 0)::bigint AS refund_cents
       FROM pos_credit_memo cm
      WHERE ${CM_REFUND_SCOPE_SQL}
        AND ${CM_REFUND_DATE_COL} >= ?
        AND ${CM_REFUND_DATE_COL} <  ?`,
    [from, to]
  );
  return Number(result.rows[0]?.refund_cents ?? 0);
}

function fmt(cents: bigint | number): string {
  const n = typeof cents === "bigint" ? Number(cents) : cents;
  return (n / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function explainDelta(pool: Pool, month: MonthWindow): Promise<string[]> {
  const notes: string[] = [];

  // Invoices posteadas en QB-sync que el replay dejó bloqueadas en este mes.
  const { rows: blockedInv } = await pool.query<{ id: string; invoice_number: string; total: string }>(
    `SELECT i.id, i.invoice_number, i.total::text
       FROM pos_invoice i
      WHERE i.status IN ('issued','partial','paid','partially_refunded','refunded')
        AND i.issued_at >= $1 AND i.issued_at < $2
        AND NOT EXISTS (
          SELECT 1 FROM bank_journal_entry e
           WHERE e.source_kind = 'pos_invoice' AND e.source_id = i.id AND e.kind = 'document'
             AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id = e.id)
        )`,
    [month.fromIso, month.toIso]
  );
  for (const r of blockedInv) {
    notes.push(`  BLOCKED invoice ${r.invoice_number} (${r.id}) total=$${fmt(BigInt(r.total))} — sin entrada GL (GL_UNBALANCED_DOCUMENT, ver replay)`);
  }

  const { rows: blockedCm } = await pool.query<{ id: string; credit_memo_number: string; total: string; ia: string | null; ns: string | null }>(
    `SELECT c.id, c.credit_memo_number, c.total::text,
            c.metadata->>'is_internal_adjustment' AS ia, c.metadata->>'never_sync_to_qb' AS ns
       FROM pos_credit_memo c
      WHERE c.status = 'completed'
        AND c.completed_at >= $1 AND c.completed_at < $2
        AND NOT EXISTS (
          SELECT 1 FROM bank_journal_entry e
           WHERE e.source_kind = 'pos_credit_memo' AND e.source_id = c.id AND e.kind = 'document'
             AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id = e.id)
        )`,
    [month.fromIso, month.toIso]
  );
  for (const r of blockedCm) {
    if (r.ia === "true" || r.ns === "true") {
      notes.push(`  SKIPPED cm ${r.credit_memo_number} (${r.id}) — ajuste interno (is_internal_adjustment/never_sync_to_qb), no debe postear ni figurar como Income`);
    } else {
      notes.push(`  BLOCKED cm ${r.credit_memo_number} (${r.id}) total=$${fmt(BigInt(r.total))} — sin entrada GL (GL_UNBALANCED_DOCUMENT, ver replay)`);
    }
  }

  // Fraud write-offs completados en el mes — no tocan Income (van a bad_debt).
  const { rows: fraud } = await pool.query<{ id: string; credit_memo_number: string; total: string }>(
    `SELECT cm.id, cm.credit_memo_number, cm.total::text
       FROM pos_credit_memo cm
      WHERE cm.status = 'completed'
        AND cm.completed_at >= $1 AND cm.completed_at < $2
        AND NOT (${cmNotFraudWriteoffSql("cm")})`,
    [month.fromIso, month.toIso]
  );
  for (const r of fraud) {
    notes.push(`  FRAUD WRITEOFF cm ${r.credit_memo_number} (${r.id}) total=$${fmt(BigInt(r.total))} — postea a bad_debt, no a Income (correcto que no aparezca en GL Income ni en refunded del reporte POS)`);
  }

  // Documentos voideados cuya reversa cayó en OTRO mes (día de reversa != día original).
  const { rows: crossMonthVoids } = await pool.query<{ id: string; invoice_number: string; issued_day: string; voided_day: string }>(
    `SELECT i.id, i.invoice_number, i.issued_at::date::text AS issued_day, i.voided_at::date::text AS voided_day
       FROM pos_invoice i
      WHERE i.status = 'voided'
        AND i.issued_at >= $1 AND i.issued_at < $2
        AND date_trunc('month', i.issued_at) <> date_trunc('month', i.voided_at)`,
    [month.fromIso, month.toIso]
  );
  for (const r of crossMonthVoids) {
    notes.push(`  CROSS-MONTH VOID invoice ${r.invoice_number} (${r.id}) issued=${r.issued_day} voided=${r.voided_day} — la reversa postea en el mes del void, no en el de emisión`);
  }

  return notes;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("gl-parity-report: DATABASE_URL no está seteada.");
    process.exit(1);
    return;
  }
  const pool = new Pool({ connectionString: url });
  const pg = pgAdapter(pool);
  try {
    const months = monthWindows();
    console.log(
      "Mes       | GL Income net | POS net revenue |     Δ     | GL COGS net | GL Sales Tax Payable Δ | GL AR closing"
    );
    console.log("-".repeat(118));

    const allNotes: Record<string, string[]> = {};

    for (const month of months) {
      const glIncome = await glIncomeNetCents(pool, month.fromDay, month.toDay);
      const netItemRevenue = await posNetItemRevenueCents(pg, month.fromIso, month.toIso);
      const cmRefund = await posCmRefundCents(pg, month.fromIso, month.toIso);
      const shippingNet = await fetchShippingCentsForPeriod(pg, month.fromIso, month.toIso);
      const posNetRevenue = netItemRevenue - cmRefund + shippingNet;
      const delta = glIncome - BigInt(posNetRevenue);

      const cogs = await glAccountTypeMovement(pool, month.fromDay, month.toDay, "CostOfGoodsSold");
      const cogsNet = cogs.debit - cogs.credit;
      const tax = await glAccountTypeMovement(pool, month.fromDay, month.toDay, "OtherCurrentLiability");
      const taxNet = tax.credit - tax.debit; // Sales Tax Payable: crédito aumenta el pasivo
      const arClosing = await glArClosingBalanceCents(pool, month.toDay);

      console.log(
        `${month.label}    | $${fmt(glIncome).padStart(11)} | $${fmt(posNetRevenue).padStart(14)} | $${fmt(
          delta
        ).padStart(8)} | $${fmt(cogsNet).padStart(9)} | $${fmt(taxNet).padStart(20)} | $${fmt(arClosing).padStart(11)}`
      );

      if (delta !== 0n) {
        allNotes[month.label] = await explainDelta(pool, month);
      }
    }

    for (const [label, notes] of Object.entries(allNotes)) {
      console.log(`\n${label} — explicación de Δ:`);
      if (notes.length === 0) console.log("  (sin documentos identificados — Δ SIN EXPLICAR)");
      for (const n of notes) console.log(n);
    }
  } finally {
    await pool.end();
  }
}

void main();
