/**
 * gl-parity-report-purchases.ts — gl-purchases-v2 §6, paridad mes a mes del
 * lado de COMPRAS. Sibling de `gl-parity-report.ts` (que cubre ventas) — un
 * archivo aparte porque el original ya está a 266 líneas y este repo limita
 * a 300 (`.claude/rules/coding-style.md` / CLAUDE.md §G).
 *
 *   DATABASE_URL=<sandbox medusa_gl> ./node_modules/.bin/tsx src/scripts/ledger/gl-parity-report-purchases.ts [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *
 * `--to` por defecto es HOY en ET (`getBusinessDateString`) — Phase 7
 * (2026-09-11): con `--to` ausente, `process.argv[indexOf(...)+1]` devolvía
 * `process.argv[0]` (el binario de node) en vez de caer al default por `??`
 * — `indexOf` da `-1` cuando no encuentra la flag, y `-1+1=0` SÍ es un índice
 * válido de `argv`. La tabla salía silenciosamente vacía, sin ninguna fila.
 * `arg()` ahora replica el patrón correcto de `replay-gl.ts`.
 *
 * Tres columnas, todas por mes de `COALESCE(document_date, confirmed_at)` ET:
 *   - Gastos: Σ GL (`cogs_default` + `qb_account_*`) vs Σ `VENDOR_BILL_LINE_CENTS`
 *     de líneas EN scope de `period-costs` (mismo criterio que clasifica el motor).
 *   - Inventory Asset (compras): movimiento neto GL del role `inventory_asset`
 *     vs la MISMA aritmética del motor reimplementada en SQL crudo sobre las
 *     tablas fuente (`receivedPlusLandedCents`, Phase 7: `landed_total_cents`
 *     es NULL en 71% de las líneas — el motor NUNCA lo usa para valuar, sólo
 *     para el hash de drift; comparar contra él medía la columna equivocada).
 *   - AP: movimiento neto GL del role `accounts_payable` vs Σ payable de bills
 *     confirmados/synced del mes (antes de pagos/créditos — es el ALTA, no el
 *     saldo). Phase 7: incluye los bills `adopted` SIN líneas propias
 *     (payable = `qb_amount_due_cents`) — el INNER JOIN a `vendor_bill_line`
 *     los excluía en silencio.
 *
 * Phase 7 — segundo bug real en `glMovement`: el `OR l.role LIKE 'qb_account_%'`
 * estaba pegado SIEMPRE, sin importar qué `roles` pedía el caller. Sólo
 * "Gastos" lo necesita (sus líneas van a cuentas con nombre variable); para
 * "InvAsset"/"AP" colaba CUALQUIER línea `qb_account_*` del período —
 * medido: el freight_charge de $8.54 de VB-1066 (capitalizado, no expensado)
 * se sumaba igual a la columna InvAsset de julio. Ahora `includeQbAccountLines`
 * es un parámetro explícito por llamada, no un default.
 *
 * Con los tres fixes (adopted, `receivedPlusLandedCents` reimplementado, y
 * este), TODO Δ restante de abril-junio es exactamente $0.00. Julio/agosto/
 * septiembre quedan con Δ ≠ 0 explicados COMPLETO por residuo real de esta
 * sesión: los mutation-tests de `verify-gl-purchases.ts` postearon y
 * reversaron de verdad (COMMIT, no rollback) contra `vb_19b14689677d4f44acf904ad27f51e1a`
 * (VB-1079) y su receipt `por_01KYWXXSQJJR19H36PQNBCD92X` — el journal es
 * append-only, esas filas no se pueden borrar. Cuantificado exacto (verificado
 * bill-por-bill: CERO discrepancias fuera de estos dos IDs):
 *   - Julio:      ΔInvAsset +$829.50 · ΔAP +$1,659.00
 *   - Agosto:     ΔInvAsset −$829.50 · ΔAP  $0.00
 *   - Septiembre: ΔInvAsset  $0.00   · ΔAP  −$829.50 (ventana 1–9, `--to` default)
 * Δ Gastos (abril–agosto, unos pocos $ a **-$79) es independiente — ninguna
 * de las dos filas de test tiene línea `cogs_default`/`qb_account`, así que
 * no puede venir de ahí; queda sin investigar (no fue parte del pedido).
 */
import { Pool } from "pg";

import { getBusinessDateString } from "../../lib/date/et";
import {
  VENDOR_BILL_LINE_CENTS,
  VENDOR_BILL_PERIOD_COST_SCOPE_SQL,
} from "../../api/admin/reports/_lib/period-costs";

function fmt(cents: bigint): string {
  const n = Number(cents);
  return (n / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function arg(name: string): string | null {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

type MonthWindow = { label: string; fromDay: string; toDay: string };

function monthWindows(fromDay: string, toDay: string): MonthWindow[] {
  const months: MonthWindow[] = [];
  let cursor = new Date(`${fromDay}T00:00:00Z`);
  const end = new Date(`${toDay}T00:00:00Z`);
  while (cursor < end) {
    const y = cursor.getUTCFullYear();
    const m = cursor.getUTCMonth();
    const nextMonth = new Date(Date.UTC(y, m + 1, 1));
    const from = cursor.toISOString().slice(0, 10);
    const to = (nextMonth < end ? nextMonth : end).toISOString().slice(0, 10);
    months.push({ label: `${y}-${String(m + 1).padStart(2, "0")}`, fromDay: from, toDay: to });
    cursor = nextMonth;
  }
  return months;
}

/**
 * Phase 7: `includeQbAccountLines` es OBLIGATORIO explícito, no un default —
 * el bug real era exactamente ese default implícito. "GL Gastos" necesita las
 * líneas `qb_account_*` (son las que aterrizan en cuentas de gasto con
 * nombre variable, `sanitizeRole` les arma el role dinámico). "GL InvAsset" y
 * "GL AP Alta" NO: filtrar sólo por `roles` con ese OR pegado de rodillas
 * colaba CUALQUIER línea `qb_account_*` del período entero en la columna de
 * inventario — medido: el freight_charge de $8.54 de VB-1066 (capitalizado
 * en `inventory_asset` cero, expensado a su propia cuenta) se sumaba
 * IGUAL a la columna "GL InvAsset" de julio, aunque su role real fuera
 * `qb_account_80000094...`, no `inventory_asset`.
 */
async function glMovement(
  pool: Pool,
  roles: string[],
  fromDay: string,
  toDay: string,
  sourceKinds: string[],
  includeQbAccountLines: boolean
): Promise<bigint> {
  const roleFilter = includeQbAccountLines
    ? "(l.role = ANY($2::text[]) OR l.role LIKE 'qb_account_%')"
    : "l.role = ANY($2::text[])";
  const { rows } = await pool.query<{ net: string }>(
    `SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0)::bigint::text AS net
       FROM bank_journal_line l
       JOIN bank_journal_entry e ON e.id = l.entry_id
      WHERE e.kind IN ('document', 'reversal')
        AND e.source_kind = ANY($1::text[])
        AND ${roleFilter}
        AND e.day >= $3 AND e.day < $4`,
    [sourceKinds, roles, fromDay, toDay]
  );
  return BigInt(rows[0]?.net ?? "0");
}

async function expensesReportCents(pool: Pool, fromDay: string, toDay: string): Promise<bigint> {
  const { rows } = await pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(${VENDOR_BILL_LINE_CENTS}), 0)::bigint::text AS total
       FROM vendor_bill_line l
       JOIN vendor_bill vb ON vb.id = l.vendor_bill_id
      WHERE (${VENDOR_BILL_PERIOD_COST_SCOPE_SQL})
        AND COALESCE(vb.document_date, vb.confirmed_at)::date >= $1
        AND COALESCE(vb.document_date, vb.confirmed_at)::date < $2`,
    [fromDay, toDay]
  );
  return BigInt(rows[0]?.total ?? "0");
}

/**
 * Reimplementa en SQL crudo EXACTAMENTE la aritmética de
 * `documents/vendor-bill-snapshot.ts::buildSnapshot` + `lines/vendor-bill.ts`
 * — la única forma honesta de comparar "lo que el motor debería postear"
 * contra "lo que posteó" sin leer el motor mismo. Por bill:
 *   netInventoryAsset = payable − offset − expensedSum − trueUp
 * más, para receipts, su propio débito a `inventory_asset` (qty × costo de
 * recepción) — la MISMA suma que `po_receipt` postea, filtrada por
 * `received_at` del mes (no por si ya tienen bill atado: un receipt sin bill
 * todavía es "recibido" igual, el motor lo postea con `postReceipt`).
 */
async function receivedPlusLandedCents(pool: Pool, fromDay: string, toDay: string): Promise<bigint> {
  const { rows: receiptRows } = await pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(
              rl.qty_received_now * ROUND(COALESCE(rl.unit_cost_cents_override, pol.unit_cost_cents)::numeric)
            ), 0)::bigint::text AS total
       FROM purchase_order_receipt por
       JOIN purchase_order_receipt_line rl ON rl.purchase_order_receipt_id = por.id
       JOIN purchase_order_line pol ON pol.id = rl.purchase_order_line_id
      WHERE por.deleted_at IS NULL AND por.voided_at IS NULL
        AND por.status IN ('applied', 'synced')
        AND por.received_at::date >= $1 AND por.received_at::date < $2`,
    [fromDay, toDay]
  );

  const { rows: billRows } = await pool.query<{ net: string }>(
    `WITH bills AS (
       SELECT vb.id
         FROM vendor_bill vb
        WHERE vb.deleted_at IS NULL AND vb.status IN ('confirmed', 'synced')
          AND COALESCE(vb.document_date, vb.confirmed_at)::date >= $1
          AND COALESCE(vb.document_date, vb.confirmed_at)::date < $2
     ),
     payable AS (
       SELECT vb.id,
              COALESCE(SUM(${VENDOR_BILL_LINE_CENTS}), 0)::bigint AS payable,
              COALESCE(SUM(CASE WHEN (${VENDOR_BILL_PERIOD_COST_SCOPE_SQL})
                                 THEN ${VENDOR_BILL_LINE_CENTS} ELSE 0 END), 0)::bigint AS expensed
         FROM bills b
         JOIN vendor_bill vb ON vb.id = b.id
         JOIN vendor_bill_line l ON l.vendor_bill_id = vb.id AND l.deleted_at IS NULL
        GROUP BY vb.id
     ),
     offset_cte AS (
       SELECT b.id,
              COALESCE(SUM(rl.qty_received_now * ROUND(COALESCE(rl.unit_cost_cents_override, pol.unit_cost_cents)::numeric)), 0)::bigint AS offset_cents
         FROM bills b
         JOIN purchase_order_receipt por ON por.vendor_bill_id = b.id AND por.deleted_at IS NULL AND por.voided_at IS NULL
         JOIN purchase_order_receipt_line rl ON rl.purchase_order_receipt_id = por.id
         JOIN purchase_order_line pol ON pol.id = rl.purchase_order_line_id
        GROUP BY b.id
     ),
     trueup_cte AS (
       SELECT vendor_bill_id AS id, COALESCE(SUM(cogs_true_up_cents), 0)::bigint AS trueup
         FROM variant_cost_event
        WHERE event_type = 'vendor_bill_receipt' AND status = 'active'
        GROUP BY vendor_bill_id
     )
     SELECT COALESCE(SUM(p.payable - COALESCE(o.offset_cents, 0) - p.expensed - COALESCE(t.trueup, 0)), 0)::bigint::text AS net
       FROM bills b
       JOIN payable p ON p.id = b.id
       LEFT JOIN offset_cte o ON o.id = b.id
       LEFT JOIN trueup_cte t ON t.id = b.id`,
    [fromDay, toDay]
  );

  // Adopted sin líneas: todo el `qb_amount_due_cents` capitaliza directo a
  // inventory_asset (documents/vendor-bill-snapshot.ts `adoptedNoLines`) —
  // sin offset/expensed/trueUp, porque no hay receipts atados ni líneas que
  // clasificar. Sin este UNION, `payable` (arriba) los excluye vía el JOIN a
  // `vendor_bill_line` y la columna repite el mismo Δ que `billPayableAltaCents`
  // ya arreglaba del lado de AP.
  const { rows: adoptedRows } = await pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(vb.qb_amount_due_cents), 0)::bigint::text AS total
       FROM vendor_bill vb
      WHERE vb.deleted_at IS NULL AND vb.status IN ('confirmed', 'synced')
        AND NOT EXISTS (SELECT 1 FROM vendor_bill_line l WHERE l.vendor_bill_id = vb.id AND l.deleted_at IS NULL)
        AND COALESCE(vb.document_date, vb.confirmed_at)::date >= $1
        AND COALESCE(vb.document_date, vb.confirmed_at)::date < $2`,
    [fromDay, toDay]
  );

  return (
    BigInt(receiptRows[0]?.total ?? "0") +
    BigInt(billRows[0]?.net ?? "0") +
    BigInt(adoptedRows[0]?.total ?? "0")
  );
}

/**
 * Phase 7: los bills `adopted` sin líneas propias (payable = `qb_amount_due_cents`)
 * quedaban afuera — el INNER JOIN a `vendor_bill_line` los descartaba en
 * silencio. `UNION ALL` con el mismo `NOT EXISTS` que usa
 * `documents/vendor-bill-snapshot.ts::buildSnapshot` para decidir la rama
 * "adopted sin líneas".
 */
async function billPayableAltaCents(pool: Pool, fromDay: string, toDay: string): Promise<bigint> {
  const { rows } = await pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(payable), 0)::bigint::text AS total FROM (
       SELECT ${VENDOR_BILL_LINE_CENTS} AS payable
         FROM vendor_bill_line l
         JOIN vendor_bill vb ON vb.id = l.vendor_bill_id
        WHERE l.deleted_at IS NULL AND vb.deleted_at IS NULL
          AND vb.status IN ('confirmed', 'synced')
          AND COALESCE(vb.document_date, vb.confirmed_at)::date >= $1
          AND COALESCE(vb.document_date, vb.confirmed_at)::date < $2
        UNION ALL
       SELECT COALESCE(vb.qb_amount_due_cents, 0)::bigint AS payable
         FROM vendor_bill vb
        WHERE vb.deleted_at IS NULL AND vb.status IN ('confirmed', 'synced')
          AND NOT EXISTS (SELECT 1 FROM vendor_bill_line l WHERE l.vendor_bill_id = vb.id AND l.deleted_at IS NULL)
          AND COALESCE(vb.document_date, vb.confirmed_at)::date >= $1
          AND COALESCE(vb.document_date, vb.confirmed_at)::date < $2
     ) x`,
    [fromDay, toDay]
  );
  return BigInt(rows[0]?.total ?? "0");
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("gl-parity-report-purchases: DATABASE_URL no está seteada.");
    process.exit(1);
    return;
  }
  const fromArg = arg("from") ?? "2026-04-14";
  const toArg = arg("to") ?? getBusinessDateString();

  const pool = new Pool({ connectionString: url });
  try {
    console.log(`gl-parity-report-purchases: ${fromArg} → ${toArg} (ET)`);
    const months = monthWindows(fromArg, toArg);
    if (months.length === 0) {
      console.log("(rango vacío — --from >= --to)");
      return;
    }
    console.log("Mes       | GL Gastos    | Reporte Gastos | Δ Gastos  | GL InvAsset  | Recv+Landed  | Δ InvAsset | GL AP Alta   | Bill Payable | Δ AP");
    console.log("-".repeat(150));
    for (const m of months) {
      const glExpense = await glMovement(pool, ["cogs_default"], m.fromDay, m.toDay, ["vendor_bill"], true);
      const reportExpense = await expensesReportCents(pool, m.fromDay, m.toDay);
      const glInv = await glMovement(pool, ["inventory_asset"], m.fromDay, m.toDay, ["po_receipt", "vendor_bill"], false);
      const receivedLanded = await receivedPlusLandedCents(pool, m.fromDay, m.toDay);
      const glAp = await glMovement(pool, ["accounts_payable"], m.fromDay, m.toDay, ["vendor_bill"], false);
      const billAlta = await billPayableAltaCents(pool, m.fromDay, m.toDay);

      console.log(
        `${m.label}    | $${fmt(glExpense).padStart(10)} | $${fmt(reportExpense).padStart(13)} | ` +
          `$${fmt(glExpense - reportExpense).padStart(7)} | $${fmt(glInv).padStart(10)} | ` +
          `$${fmt(receivedLanded).padStart(10)} | $${fmt(glInv - receivedLanded).padStart(8)} | ` +
          `$${fmt(-glAp).padStart(10)} | $${fmt(billAlta).padStart(10)} | $${fmt(-glAp - billAlta).padStart(6)}`
      );
    }
    console.log(
      "\nNota: GL AP Alta se imprime en positivo (-glAp, ya que el role acumula crédito) para compararlo directo contra el ALTA de payable del mes — NO es el saldo (eso lo cubre verify-gl-purchases §1)."
    );
  } finally {
    await pool.end();
  }
}

void main();
