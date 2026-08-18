/**
 * verify-reports-commission.ts — gate estático de las dos bases de comisión
 * en los reportes de ventas/compras.
 *
 * Correr con: ./node_modules/.bin/tsx src/scripts/verify/verify-reports-commission.ts
 * (termina con "doesn't default export" — preexistente, no arreglar.)
 *
 * Qué protege: `sales/summary` (base LIQUIDACIÓN) y `purchases/cost-profit`
 * (base DEVENGADO) miden la comisión con criterios DISTINTOS a propósito
 * (`commission-expr.ts`). Mezclar las bases, o replicar la fórmula del monto
 * de un beneficiario fuera de `effectiveAmountCents`, es el bug que este
 * gate existe para prevenir — misma familia que `verify-order-commissions.ts`
 * check 9 (una sola derivación del monto).
 */

import { readFileSync } from "fs";
import { resolve } from "path";

import { prorateCommissionAcrossInvoices } from "../../api/admin/reports/_lib/commission-expr";

const ROOT = resolve(__dirname, "../../..");
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf8");

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) {
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

// Descarta líneas comentadas (`//…`) antes de buscar código VIVO — un
// comentario que menciona el string buscado no cuenta como uso real.
const liveSource = (src: string): string =>
  src
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .join("\n");

console.log("verify-reports-commission — bases devengado/liquidación en los reportes\n");

const SALES_SUMMARY = "src/api/admin/reports/sales/summary/route.ts";
const COST_PROFIT = "src/api/admin/reports/purchases/cost-profit/route.ts";
const COMMISSION_EXPR = "src/api/admin/reports/_lib/commission-expr.ts";

const salesSummarySrc = read(SALES_SUMMARY);
const costProfitSrc = read(COST_PROFIT);
const commissionExprSrc = read(COMMISSION_EXPR);
const salesSummaryLive = liveSource(salesSummarySrc);
const costProfitLive = liveSource(costProfitSrc);

// 1 · summary/route.ts usa SOLO la base liquidación
check(
  "sales/summary importa fetchSettledCommissionCentsForPeriod",
  salesSummaryLive.includes("fetchSettledCommissionCentsForPeriod")
);
check(
  "sales/summary NO importa fetchAccruedCommissionCentsForPeriod (bases distintas — no mezclar)",
  !salesSummaryLive.includes("fetchAccruedCommissionCentsForPeriod")
);

// 2 · cost-profit/route.ts usa SOLO la base devengado
check(
  "purchases/cost-profit importa fetchAccruedCommissionCentsForPeriod",
  costProfitLive.includes("fetchAccruedCommissionCentsForPeriod")
);
check(
  "purchases/cost-profit NO importa fetchSettledCommissionCentsForPeriod (bases distintas — no mezclar)",
  !costProfitLive.includes("fetchSettledCommissionCentsForPeriod")
);

// 3 · ningún route replica la fórmula del monto de un beneficiario — una
// sola derivación, encapsulada en commission-expr.ts.
{
  const FORMULA_MARKERS = ["effectiveAmountCents", "percent_bps", "order_commission_recipient"];
  for (const rel of [SALES_SUMMARY, COST_PROFIT] as const) {
    const live = rel === SALES_SUMMARY ? salesSummaryLive : costProfitLive;
    for (const marker of FORMULA_MARKERS) {
      check(
        `${rel.split("/").slice(-2).join("/")} NO replica la fórmula (sin '${marker}')`,
        !live.includes(marker)
      );
    }
  }
}

// 4 · sales/summary sirve commission + profit_after_commissions, y
// gross_profit NO le resta la comisión (línea de definición aislada).
{
  const jsonStart = salesSummaryLive.indexOf("return res.json({");
  const jsonEnd = jsonStart >= 0 ? salesSummaryLive.indexOf("\n  } catch", jsonStart) : -1;
  const jsonBlock =
    jsonStart >= 0 && jsonEnd > jsonStart ? salesSummaryLive.slice(jsonStart, jsonEnd) : "";
  check(
    "sales/summary sirve commission y profit_after_commissions en el res.json()",
    !!jsonBlock && jsonBlock.includes("commission,") && jsonBlock.includes("profit_after_commissions,")
  );
  const grossProfitLine = salesSummaryLive
    .split("\n")
    .find((line) => /const\s+gross_profit\s*=/.test(line));
  check(
    "sales/summary: la línea que define gross_profit NO menciona commission",
    !!grossProfitLine && !/commission/i.test(grossProfitLine),
    grossProfitLine?.trim()
  );
}

// 5 · cost-profit sirve totals.commission/profit_after_commissions, y
// `profit` (profitCents) no menciona commission.
{
  const totalsStart = costProfitLive.indexOf("totals: {");
  const totalsEnd = totalsStart >= 0 ? costProfitLive.indexOf("},", totalsStart) : -1;
  const totalsBlock =
    totalsStart >= 0 && totalsEnd > totalsStart ? costProfitLive.slice(totalsStart, totalsEnd) : "";
  check(
    "cost-profit sirve totals.commission y totals.profit_after_commissions",
    !!totalsBlock &&
      totalsBlock.includes("commission:") &&
      totalsBlock.includes("profit_after_commissions:")
  );
  const profitCentsLine = costProfitLive
    .split("\n")
    .find((line) => /const\s+profitCents\s*=/.test(line));
  check(
    "cost-profit: la línea que define profitCents NO menciona commission",
    !!profitCentsLine && !/commission/i.test(profitCentsLine),
    profitCentsLine?.trim()
  );
}

// 6 · cost-profit NO agrega comisión a by_category / by_vendor — ninguno de
// los SELECTs que alimentan esos arrays, ni el mapper que los construye,
// menciona commission.
{
  const byCatStart = costProfitLive.indexOf("byCatResult");
  const byVendorStart = costProfitLive.indexOf("byVendorResult");
  const mapRowsStart = costProfitLive.indexOf("const mapRows");
  const mapRowsEnd = mapRowsStart >= 0 ? costProfitLive.indexOf("\n\n", mapRowsStart) : -1;
  const mapRowsBody =
    mapRowsStart >= 0 && mapRowsEnd >= 0 ? costProfitLive.slice(mapRowsStart, mapRowsEnd) : "";
  const respBlockStart = costProfitLive.indexOf("by_category:");
  const respBlockEnd = costProfitLive.indexOf("})", respBlockStart);
  const respBlock =
    respBlockStart >= 0 && respBlockEnd >= 0 ? costProfitLive.slice(respBlockStart, respBlockEnd) : "";
  check(
    "cost-profit: by_category/by_vendor y mapRows() no mencionan commission",
    byCatStart >= 0 &&
      byVendorStart >= 0 &&
      !!mapRowsBody &&
      !mapRowsBody.includes("commission") &&
      !!respBlock &&
      !respBlock.includes("commission")
  );
}

// 7 · commission-expr.ts reusa, no duplica: effectiveAmountCents de
// lib/commissions/calculator y NET_ITEM_REVENUE de ./revenue-expr.
check(
  "commission-expr.ts importa effectiveAmountCents de lib/commissions/calculator",
  /import\s*\{[^}]*effectiveAmountCents[^}]*\}\s*from\s*["']\.\.\/\.\.\/\.\.\/\.\.\/lib\/commissions\/calculator["']/.test(
    commissionExprSrc
  )
);
check(
  "commission-expr.ts importa NET_ITEM_REVENUE de ./revenue-expr",
  /import\s*\{[^}]*NET_ITEM_REVENUE[^}]*\}\s*from\s*["']\.\/revenue-expr["']/.test(commissionExprSrc)
);

// 8 · la query de LIQUIDACIÓN usa AT TIME ZONE. Cortamos hasta el CIERRE de
// la función (`\n}`), NUNCA hasta la próxima declaración `export` — el
// docblock de fetchAccrued (que también menciona "AT TIME ZONE" al explicar
// la asimetría deliberada) precede a su `export async function` y quedaría
// adentro del slice, dejando este check ciego a que el SQL real la pierda.
{
  const commissionExprLive = liveSource(commissionExprSrc);
  const start = commissionExprLive.indexOf(
    "export async function fetchSettledCommissionCentsForPeriod"
  );
  const end = start >= 0 ? commissionExprLive.indexOf("\n}", start) : -1;
  const body = start >= 0 && end > start ? commissionExprLive.slice(start, end) : "";
  check(
    "fetchSettledCommissionCentsForPeriod usa AT TIME ZONE",
    !!body && body.includes("AT TIME ZONE")
  );
}

// 9 · ejercitar prorateCommissionAcrossInvoices REAL (es pura).
{
  const equal = prorateCommissionAcrossInvoices(100, [1, 1, 1]);
  check(
    "prorateCommissionAcrossInvoices(100, [1,1,1]) suma 100",
    equal.reduce((s, v) => s + v, 0) === 100,
    JSON.stringify(equal)
  );

  const uneven = prorateCommissionAcrossInvoices(1000, [7000, 3000]);
  check(
    "prorateCommissionAcrossInvoices(1000, [7000,3000]) === [700,300]",
    uneven.length === 2 && uneven[0] === 700 && uneven[1] === 300,
    JSON.stringify(uneven)
  );

  const empty = prorateCommissionAcrossInvoices(500, []);
  check(
    "prorateCommissionAcrossInvoices(500, []) === []",
    Array.isArray(empty) && empty.length === 0,
    JSON.stringify(empty)
  );

  const zeroWeights = prorateCommissionAcrossInvoices(300, [0, 0]);
  check(
    "prorateCommissionAcrossInvoices(300, [0,0]) suma 300",
    zeroWeights.reduce((s, v) => s + v, 0) === 300,
    JSON.stringify(zeroWeights)
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Frontend — resuelto relativo al workspace (ROOT = backend/, así que
// ../store-pos apunta al sub-proyecto hermano). FALLA con mensaje claro si
// no existe, nunca saltea en silencio.
// ─────────────────────────────────────────────────────────────────────────
const SALES_PAGE = "../store-pos/app/(pos)/reports/sales/page.tsx";
const COST_PROFIT_TAB = "../store-pos/app/(pos)/reports/purchases/_tabs/CostProfit.tsx";

let salesPageSrc: string | null = null;
try {
  salesPageSrc = read(SALES_PAGE);
} catch {
  salesPageSrc = null;
}
let costProfitTabSrc: string | null = null;
try {
  costProfitTabSrc = read(COST_PROFIT_TAB);
} catch {
  costProfitTabSrc = null;
}

// 10 · sales/page.tsx: tiles Commissions + Profit after comm. y tooltip
// literal de liquidación.
if (salesPageSrc === null) {
  check(`store-pos sales/page.tsx existe en ${SALES_PAGE} (resuelto desde ${ROOT})`, false);
} else {
  check(
    "sales/page.tsx: tile 'Commissions' presente",
    salesPageSrc.includes("'Commissions'")
  );
  check(
    "sales/page.tsx: tile 'Profit after comm.' presente",
    salesPageSrc.includes("'Profit after comm.'")
  );
  check(
    "sales/page.tsx: tooltip contiene 'Por fecha de liquidación'",
    salesPageSrc.includes("Por fecha de liquidación")
  );
}

// 11 · CostProfit.tsx: label de devengado y ningún DonutChart con commission.
if (costProfitTabSrc === null) {
  check(`store-pos CostProfit.tsx existe en ${COST_PROFIT_TAB} (resuelto desde ${ROOT})`, false);
} else {
  check(
    "CostProfit.tsx: contiene 'Devengado en la venta'",
    costProfitTabSrc.includes("Devengado en la venta")
  );

  const donutBlocks: string[] = [];
  let cursor = 0;
  for (;;) {
    const start = costProfitTabSrc.indexOf("<DonutChart", cursor);
    if (start < 0) break;
    const end = costProfitTabSrc.indexOf("/>", start);
    donutBlocks.push(costProfitTabSrc.slice(start, end < 0 ? undefined : end));
    cursor = end < 0 ? costProfitTabSrc.length : end + 2;
  }
  check(
    "CostProfit.tsx: encontró al menos un <DonutChart /> para auditar",
    donutBlocks.length > 0,
    `${donutBlocks.length} bloques`
  );
  check(
    "CostProfit.tsx: ningún <DonutChart /> referencia commission",
    donutBlocks.every((block) => !block.includes("commission"))
  );
}

// 12 · el tile de Gross Profit sigue existiendo (no se renombró/fusionó).
if (salesPageSrc !== null) {
  check(
    "sales/page.tsx: tile 'Gross Profit' sigue existiendo",
    // `'Gross Profit'` sola matchea también el tab de la tabla desglosada
    // (`{ id: 'gross-profit', label: 'Gross Profit' }`) — el KPI tile se
    // reconoce por el PAR label+value juntos, no por el string suelto.
    salesPageSrc.includes("label: 'Gross Profit',") &&
      salesPageSrc.includes("value: formatMoney(grossProfit)")
  );
}

console.log("");
if (failures.length > 0) {
  console.error(`❌ ${failures.length} chequeo(s) fallaron:`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log("✅ verify-reports-commission: todo verificado.");
