/**
 * verify-period-costs.ts — gate de los reportes Expenses y Profit & Loss.
 *
 * Correr (contra el SANDBOX, que es donde viven los fixtures del E2E):
 *   env DATABASE_URL="<sandbox>" VERIFY_API_URL=http://localhost:9099 \
 *     ./node_modules/.bin/tsx src/scripts/verify/verify-period-costs.ts
 *
 * Script tsx PLANO, sin `export default` (un verify con export default corrido
 * por tsx no ejecuta nada y sale 0). Read-only: sólo SELECT.
 *
 * ── Qué protege ──────────────────────────────────────────────────────────────
 *
 * 1. La clasificación de "costo del período" (`_lib/period-costs.ts`) contra
 *    una SEGUNDA implementación en JS que parte de las tablas crudas: mismo
 *    universo, misma respuesta, por bucket y al centavo. Un cambio en el SQL
 *    que mueva plata de bucket sin mover esta copia falla acá.
 * 2. Ningún costo CAPITALIZADO entra a los totales: un bill referenciado por un
 *    regular, o atado a PO, no puede aparecer en el bucket `cost`.
 * 3. El write-off por fraude aparece UNA vez, en Expense, y no reduce ventas:
 *    la línea de devoluciones del P&L es exactamente lo que Sales netea.
 * 4. Un memo cuyas líneas son el item de fraude pero SIN la marca en metadata
 *    es una excepción: contaría como devolución en silencio.
 * 5. Los buckets que no suman (unclassified, pending_link, balance_sheet) NO
 *    entran a las secciones ni a los totales — probado con fixtures puros.
 * 6. Expenses y P&L cuentan la misma plata: los totales por tipo coinciden.
 * 7. Paridad con Sales por HTTP: el `product_margin` del P&L es el
 *    `gross_profit` de `sales/summary` (tolerancia $1 por el `::bigint` que
 *    Sales aplica al COGS), y `income.total` es su `net_revenue`.
 *
 * Los checks de datos EXIGEN fixtures: sin un memo de fraude completado, sin
 * un bill standalone o sin un sibling capitalizado en la base, el check
 * correspondiente FALLA — no pasa en vacío. El E2E los siembra antes.
 *
 * Mutation-testeado (2026-09-08), con un hallazgo que conviene saber: en los
 * datos de hoy TODO sibling referenciado por un regular está además atado a
 * una PO, así que las dos exclusiones del scope se cubren mutuamente y quitar
 * UNA sola es invisible para los checks de datos — las cazan los checks
 * estructurales del scope. Quitar las DOS a la vez sí la caza el cruce de
 * datos (check 1: `pending_link` salta de 114.264 a 5.124.857 centavos).
 * Además: sin el filtro de bucket en `accountLines` cae el check 5; sin el
 * `NOT (…)` del predicado de fraude en `fetchFraudWriteoffLines` cae el 3.
 */
import { readFileSync } from "fs";
import { resolve } from "path";

import { Client } from "pg";

import {
  type PeriodCostLine,
  VENDOR_BILL_PENDING_LINK_SQL,
  VENDOR_BILL_PERIOD_COST_SCOPE_SQL,
  fetchPeriodCostLines,
  summarizePeriodCosts,
} from "../../api/admin/reports/_lib/period-costs";
import { assemble } from "../../api/admin/reports/_lib/pnl-statement";
import {
  fetchCmRefundsCentsForPeriod,
  fetchFraudWriteoffCentsForPeriod,
} from "../../api/admin/reports/_lib/sales-revenue";
import {
  FRAUD_WRITEOFF_QB_ACCOUNT,
  FRAUD_WRITEOFF_QB_LIST_ID,
} from "../../lib/reports/fraud-writeoff";

const ROOT = resolve(__dirname, "../../..");
const FROM = process.env.VERIFY_FROM ?? "2000-01-01T05:00:00.000Z";
const TO = process.env.VERIFY_TO ?? "2100-01-01T05:00:00.000Z";

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};

/** Adaptador knex.raw → pg: `?` → `$n` en orden, igual que knex. */
function rawAdapter(client: Client) {
  return {
    raw: async (sql: string, bindings: unknown[]) => {
      let i = 0;
      const translated = sql.replace(/\?/g, () => `$${++i}`);
      if (i !== bindings.length) throw new Error(`placeholders ${i} != bindings ${bindings.length}`);
      return client.query(translated, bindings as never[]);
    },
  };
}

const COST_TYPES = new Set(["CostOfGoodsSold", "Expense", "OtherExpense"]);
const INCOME_TYPES = new Set(["Income", "OtherIncome"]);

/**
 * Segunda implementación, deliberadamente ingenua y en JS: lee bills y líneas
 * crudos y clasifica fila por fila. No comparte ni una expresión con el SQL
 * del módulo — si comparten, el check es una tautología.
 */
async function independentBillClassification(client: Client) {
  const bills = await client.query(
    `SELECT vb.id, vb.number, vb.bill_type, vb.status, vb.purchase_order_id, vb.vendor_id,
            vb.freight_allocation_basis, COALESCE(vb.document_date, vb.created_at) AS d
       FROM vendor_bill vb WHERE vb.deleted_at IS NULL`
  );
  const referenced = new Set<string>();
  for (const b of await client.query(
    `SELECT service_vendor_bill_id s, freight_vendor_bill_id f, tariff_vendor_bill_id t
       FROM vendor_bill WHERE deleted_at IS NULL AND status NOT IN ('cancelled','voided','deleted')`
  ).then((r) => r.rows)) {
    for (const id of [b.s, b.f, b.t]) if (id) referenced.add(String(id));
  }
  const agentVendors = new Set<string>(
    (await client.query(
      `SELECT id FROM qb_vendor WHERE COALESCE((metadata->>'is_china_agent')::boolean, false)`
    )).rows.map((r) => String(r.id))
  );
  const accountTypes = new Map<string, string>(
    (await client.query(`SELECT qb_list_id, account_type FROM qb_account WHERE deleted_at IS NULL`)).rows
      .map((r) => [String(r.qb_list_id), String(r.account_type)])
  );
  const lines = await client.query(
    `SELECT vendor_bill_id, line_kind, qb_account_list_id, qb_account_type,
            amount_cents, qty, unit_cost_cents
       FROM vendor_bill_line WHERE deleted_at IS NULL AND line_type = 'qb_account'`
  );
  const byBill = new Map(bills.rows.map((b) => [String(b.id), b]));
  const totals = { cost: 0, income: 0, balance_sheet: 0, unclassified: 0, pending_link: 0 };
  const costBillIds = new Set<string>();
  const from = new Date(FROM).getTime();
  const to = new Date(TO).getTime();
  for (const l of lines.rows) {
    const b = byBill.get(String(l.vendor_bill_id));
    if (!b) continue;
    if (!["confirmed", "synced"].includes(String(b.status))) continue;
    const d = new Date(b.d).getTime();
    if (d < from || d >= to) continue;
    const kind = l.line_kind ? String(l.line_kind) : "";
    if (kind === "tax_charge") continue;
    if (kind === "freight_charge" && b.freight_allocation_basis) continue;
    const sibling = ["service", "freight", "tariff"].includes(String(b.bill_type));
    if (sibling && b.purchase_order_id) continue;
    if (referenced.has(String(b.id))) continue;
    const cents =
      l.amount_cents != null ? Number(l.amount_cents) : Math.round(Number(l.qty) * Number(l.unit_cost_cents));
    const type = (l.qb_account_type && String(l.qb_account_type).trim()) || accountTypes.get(String(l.qb_account_list_id)) || "";
    if (sibling && agentVendors.has(String(b.vendor_id))) { totals.pending_link += cents; continue; }
    if (!type) totals.unclassified += cents;
    else if (COST_TYPES.has(type)) { totals.cost += cents; costBillIds.add(String(b.id)); }
    else if (INCOME_TYPES.has(type)) totals.income -= cents; // un bill debita la cuenta de ingreso
    else totals.balance_sheet += cents;
  }
  return { totals, costBillIds, referenced, billsById: byBill };
}

async function main(): Promise<void> {
  console.log("── verify-period-costs ──\n");
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL es obligatoria");
    process.exit(2);
  }

  // ── Estructural: la exclusión de capitalizados está en el scope y el módulo la usa ──
  const src = readFileSync(resolve(ROOT, "src/api/admin/reports/_lib/period-costs.ts"), "utf8");
  check("scope excluye tax_charge", VENDOR_BILL_PERIOD_COST_SCOPE_SQL.includes("<> 'tax_charge'"));
  check("scope excluye freight_charge con basis", VENDOR_BILL_PERIOD_COST_SCOPE_SQL.includes("freight_allocation_basis IS NOT NULL"));
  check("scope excluye siblings atados a PO", VENDOR_BILL_PERIOD_COST_SCOPE_SQL.includes("vb.purchase_order_id IS NOT NULL"));
  check("scope excluye bills referenciados por un regular (NOT EXISTS)", /NOT EXISTS[\s\S]*service_vendor_bill_id = vb\.id[\s\S]*freight_vendor_bill_id = vb\.id[\s\S]*tariff_vendor_bill_id = vb\.id/.test(VENDOR_BILL_PERIOD_COST_SCOPE_SQL));
  check("scope sólo confirmed/synced", VENDOR_BILL_PERIOD_COST_SCOPE_SQL.includes("vb.status IN ('confirmed', 'synced')"));
  check("la query de bills interpola el scope compartido", src.includes("WHERE ${VENDOR_BILL_PERIOD_COST_SCOPE_SQL}"));
  check("la query de bills interpola el predicado pending_link", src.includes("${VENDOR_BILL_PENDING_LINK_SQL} AS pending_link"));
  check("pending_link se decide por el flag del vendor, no por nombre", VENDOR_BILL_PENDING_LINK_SQL.includes("is_china_agent") && !/full_name/i.test(VENDOR_BILL_PENDING_LINK_SQL));
  check("el fraude se clasifica por ListID de cuenta, no por nombre", src.includes("FRAUD_WRITEOFF_QB_ACCOUNT.list_id") && !/ILIKE\s*'%bad debt/i.test(src));

  // ── Puros: buckets que no suman ──────────────────────────────────────────────
  const mk = (over: Partial<PeriodCostLine>): PeriodCostLine => ({
    source: "vendor_bill", document_id: "x", document_number: "VB-X", document_kind: "Vendor bill",
    document_date: FROM, counterparty: null, account_list_id: "L1", account_full_name: "Acc",
    account_type: "CostOfGoodsSold", bucket: "cost", amount_cents: 100, description: null,
    document_status: "synced", qb_synced: true, qb_ref: null, link_path: "/x", ...over,
  });
  const pureLines: PeriodCostLine[] = [
    mk({ document_id: "a", amount_cents: 1000 }),
    mk({ document_id: "b", account_list_id: "L2", account_type: "Expense", amount_cents: 250 }),
    mk({ document_id: "c", account_list_id: "L3", account_type: "CostOfGoodsSold", bucket: "pending_link", amount_cents: 9999 }),
    mk({ document_id: "d", account_list_id: null, account_type: "Unclassified", bucket: "unclassified", amount_cents: 77 }),
    mk({ document_id: "d2", account_list_id: null, account_type: "Unclassified", bucket: "unclassified", amount_cents: -77 }),
    mk({ document_id: "e", account_list_id: "L5", account_type: "Bank", bucket: "balance_sheet", amount_cents: 5 }),
    mk({ document_id: "f", source: "rounding", account_list_id: "L6", account_type: "Income", bucket: "income", amount_cents: -2 }),
  ];
  const pure = summarizePeriodCosts(pureLines);
  check("summary: cost_cents suma sólo el bucket cost", pure.cost_cents === 1250, `got ${pure.cost_cents}`);
  check("summary: pending_link fuera de los totales pero visible", pure.pending_link_cents === 9999 && pure.cost_cents_by_type.CostOfGoodsSold === 1000);
  check("summary: unclassified marca incomplete aunque las líneas se cancelen", pure.incomplete === true && pure.unclassified_cents === 0);
  check("summary: balance sheet excluido y contado", pure.excluded_balance_sheet_cents === 5);
  check("summary: income con signo", pure.income_cents === -2);

  const stmt = assemble(
    { from: FROM, to: TO },
    { invoiceCount: 1, revenueCents: 100000, cogsDollars: 400 },
    1000, 5000, 50, 10, 7, 12345, pureLines
  );
  const cogsLabels = stmt.cogs.lines.map((l) => l.key);
  check("assemble: la línea pending_link NO entra a la sección COGS", !cogsLabels.includes("cogs:L3") && cogsLabels.includes("cogs:L1"));
  check("assemble: Expense sólo con bucket cost", stmt.expense.lines.length === 1 && stmt.expense.total === 2.5);
  check("assemble: income incluye el redondeo con signo", stmt.income.lines.some((l) => l.key === "income:L6" && l.amount === -0.02));
  check("assemble: gross_profit = income − cogs", Math.abs(stmt.gross_profit - (stmt.income.total - stmt.cogs.total)) < 0.005);
  check("assemble: product_margin = net revenue − COGS neto de producto", Math.abs(stmt.product_margin - (1000 + 10 - 50 - (400 + 10 - 50))) < 0.005, `got ${stmt.product_margin}`);
  check("assemble: memo no suma (pending_link, unclassified) y declara surcharge", stmt.memo.pending_link === 99.99 && stmt.memo.unclassified === 0 && stmt.memo.incomplete === true && stmt.memo.surcharge_excluded === true);

  // ── Datos ────────────────────────────────────────────────────────────────────
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const pg = rawAdapter(client);
  try {
    const lines = await fetchPeriodCostLines(pg, FROM, TO);
    const summary = summarizePeriodCosts(lines);
    const indep = await independentBillClassification(client);

    const billLines = lines.filter((l) => l.source === "vendor_bill");
    const got = { cost: 0, income: 0, balance_sheet: 0, unclassified: 0, pending_link: 0 };
    for (const l of billLines) got[l.bucket] += l.amount_cents;
    for (const k of Object.keys(got) as (keyof typeof got)[]) {
      check(`1. bills ${k}: SQL == clasificación independiente`, got[k] === indep.totals[k], `sql=${got[k]} indep=${indep.totals[k]}`);
    }
    check("fixture: hay al menos un bill standalone en cost", indep.totals.cost > 0, "sin bill standalone confirmado no hay nada que verificar");
    check("fixture: hay al menos un sibling capitalizado (referenciado por un regular)", indep.referenced.size > 0);

    const leaked = billLines.filter((l) => l.bucket === "cost" && indep.referenced.has(l.document_id));
    check("2. ningún bill referenciado por un regular está en cost", leaked.length === 0, leaked.map((l) => l.document_number).join(","));
    const leakedPo = billLines.filter((l) => l.bucket === "cost" && ["service", "freight", "tariff"].includes(String(indep.billsById.get(l.document_id)?.bill_type)) && indep.billsById.get(l.document_id)?.purchase_order_id);
    check("2b. ningún sibling atado a PO está en cost", leakedPo.length === 0, leakedPo.map((l) => l.document_number).join(","));

    // 3. fraude
    const fraudCents = await fetchFraudWriteoffCentsForPeriod(pg, FROM, TO);
    const refundCents = await fetchCmRefundsCentsForPeriod(pg, FROM, TO);
    const fraudLines = lines.filter((l) => l.source === "fraud_writeoff");
    const fraudSum = fraudLines.reduce((s, l) => s + l.amount_cents, 0);
    check("fixture: hay al menos un memo de fraude completado", fraudCents > 0, "sembrar CM fraud_writeoff en el sandbox antes de correr");
    check("3. fraude: líneas del reporte == complemento de Sales, al centavo", fraudSum === fraudCents, `lines=${fraudSum} sales=${fraudCents}`);
    check("3b. fraude: todas las líneas van a la cuenta Expense por ListID", fraudLines.every((l) => l.account_list_id === FRAUD_WRITEOFF_QB_ACCOUNT.list_id && l.account_type === "Expense" && l.bucket === "cost"));
    const stmtData = assemble({ from: FROM, to: TO }, { invoiceCount: 0, revenueCents: 0, cogsDollars: 0 }, 0, refundCents, 0, 0, 0, 0, lines);
    const expenseFraud = stmtData.expense.lines.find((l) => l.account_list_id === FRAUD_WRITEOFF_QB_ACCOUNT.list_id);
    check("3c. P&L: el fraude es UNA línea de Expense y vale lo mismo", !!expenseFraud && Math.abs(expenseFraud.amount * 100 - fraudCents) < 1, `line=${expenseFraud?.amount}`);
    const returnsLine = stmtData.income.lines.find((l) => l.key === "returns");
    check("3d. P&L: las devoluciones son las de Sales (sin el fraude)", !!returnsLine && Math.abs(returnsLine.amount * 100 + refundCents) < 1);

    // 4. memos con el item de fraude sin marca
    const orphan = await client.query(
      `SELECT cm.credit_memo_number
         FROM pos_credit_memo cm
        WHERE cm.deleted_at IS NULL AND cm.status = 'completed'
          AND COALESCE(cm.metadata->>'reporting_treatment','') <> 'fraud_writeoff'
          AND EXISTS (SELECT 1 FROM pos_credit_memo_item cmi JOIN product_variant pv ON pv.id = cmi.variant_id
                       WHERE cmi.credit_memo_id = cm.id AND cmi.deleted_at IS NULL AND pv.metadata->>'quickbooks_id' = $1)
          AND NOT EXISTS (SELECT 1 FROM pos_credit_memo_item cmi LEFT JOIN product_variant pv ON pv.id = cmi.variant_id
                       WHERE cmi.credit_memo_id = cm.id AND cmi.deleted_at IS NULL AND COALESCE(pv.metadata->>'quickbooks_id','') <> $1)`,
      [FRAUD_WRITEOFF_QB_LIST_ID]
    );
    check("4. ningún memo completado con SOLO el item de fraude carece de la marca", orphan.rowCount === 0, orphan.rows.map((r) => r.credit_memo_number).join(","));

    // 5. pending_link sólo del agente
    const agentIds = new Set((await client.query(`SELECT id FROM qb_vendor WHERE COALESCE((metadata->>'is_china_agent')::boolean,false)`)).rows.map((r) => String(r.id)));
    const badPending = billLines.filter((l) => l.bucket === "pending_link" && !agentIds.has(String(indep.billsById.get(l.document_id)?.vendor_id)));
    check("5. pending_link sólo para vendors con is_china_agent", badPending.length === 0, badPending.map((l) => l.document_number).join(","));

    // 6. Expenses == P&L cost lines
    const costCentsOf = (st: ReturnType<typeof assemble>): number =>
      [...st.cogs.lines, ...st.expense.lines]
        .filter((l) => l.account_list_id !== undefined)
        .reduce((s, l) => s + Math.round(l.amount * 100), 0) +
      st.other.lines
        .filter((l) => l.account_type === "OtherExpense")
        .reduce((s, l) => s - Math.round(l.amount * 100), 0); // en Other va negado
    const pnlCostAccounts = costCentsOf(stmtData);
    check("6. Expenses (cost por tipo) == líneas de cuenta del P&L", pnlCostAccounts === summary.cost_cents, `pnl=${pnlCostAccounts} expenses=${summary.cost_cents}`);

    // 7. paridad HTTP con sales/summary
    const api = process.env.VERIFY_API_URL;
    if (!api) {
      check("7. paridad HTTP con sales/summary", false, "VERIFY_API_URL no seteada — el check no corrió (no es verde)");
    } else {
      const email = process.env.SANDBOX_ADMIN_EMAIL ?? "sandbox@test.com";
      const password = process.env.SANDBOX_ADMIN_PASSWORD ?? "sandbox123";
      const login = await fetch(`${api}/auth/user/emailpass`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
      const token = ((await login.json()) as { token?: string }).token ?? "";
      const q = `from=${encodeURIComponent(process.env.VERIFY_HTTP_FROM ?? "2026-09-01T04:00:00.000Z")}&to=${encodeURIComponent(process.env.VERIFY_HTTP_TO ?? "2026-10-01T04:00:00.000Z")}`;
      const h = { Authorization: `Bearer ${token}` };
      const sales = (await (await fetch(`${api}/admin/reports/sales/summary?${q}`, { headers: h })).json()) as Record<string, number>;
      const pnl = (await (await fetch(`${api}/admin/reports/profit-loss/statement?${q}`, { headers: h })).json()) as { current: ReturnType<typeof assemble> };
      const exp = (await (await fetch(`${api}/admin/reports/expenses/summary?${q}`, { headers: h })).json()) as { totals: { cost_total: number } };
      const c = pnl.current;
      const incomeBucket = c.income.lines.filter((l) => l.account_list_id !== undefined).reduce((s, l) => s + l.amount, 0);
      check("7a. P&L income.total − líneas de cuenta (redondeo) == Sales net_revenue", Math.abs(c.income.total - incomeBucket - sales.net_revenue) < 0.011, `pnl=${c.income.total} rounding=${incomeBucket} sales=${sales.net_revenue}`);
      check("7b. P&L product_margin == Sales gross_profit (±$1 por el ::bigint de Sales)", Math.abs(c.product_margin - sales.gross_profit) <= 1, `pnl=${c.product_margin} sales=${sales.gross_profit}`);
      check("7c. P&L memo.commission_settled_basis == Sales commission", Math.abs(c.memo.commission_settled_basis - sales.commission) < 0.011);
      check("7d. P&L Expense fraude == Sales fraud_loss", Math.abs((c.expense.lines.find((l) => l.account_list_id === FRAUD_WRITEOFF_QB_ACCOUNT.list_id)?.amount ?? 0) - sales.fraud_loss) < 0.011, `sales=${sales.fraud_loss}`);
      const pnlCost = costCentsOf(c) / 100;
      check("7e. Expenses cost_total == líneas de cuenta del P&L (HTTP, con signo)", Math.abs(pnlCost - exp.totals.cost_total) < 0.011, `pnl=${pnlCost} expenses=${exp.totals.cost_total}`);
    }
  } finally {
    await client.end();
  }

  console.log("");
  if (failures.length) {
    console.log(`❌ ROJO — ${failures.length} fallo(s)`);
    for (const f of failures) console.log(`   · ${f}`);
    process.exit(1);
  }
  console.log("✅ VERDE");
}

main().catch((e) => {
  console.error("❌", e instanceof Error ? e.message : e);
  process.exit(1);
});
