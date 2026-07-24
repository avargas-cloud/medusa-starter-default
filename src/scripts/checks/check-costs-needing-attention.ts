/**
 * Products whose cost basis needs a human decision.
 *
 * WHY: after the China cost-basis restatement (docs/COST_BASIS_RESTATEMENT.md)
 * every product that COULD be reconstructed was. What is left is the residue —
 * products where no cost exists anywhere to reconstruct FROM. Those cannot be
 * fixed by any script; someone has to enter a cost or post the purchase. This
 * report finds them and ranks them by how much money is actually exposed, so
 * the ones bleeding today get attention before the dormant ones.
 *
 * The four findings, worst first:
 *
 *   NO_AVERAGE_COST     Sells with $0 COGS. Every sale books as pure profit,
 *                       and inventory carries no value. The most expensive kind
 *                       of wrong.
 *   BELOW_PURCHASE      average_cost is BELOW the factory price. Physically
 *                       impossible — landed cost is factory plus freight plus
 *                       commission plus duty, it can never be less. Signature of
 *                       an averaging bug.
 *   NO_LANDED_APPLIED   average_cost equals purchase_cost, so the product is
 *                       carried at raw factory price with no freight, commission
 *                       or duty. For a China product this understates COGS by
 *                       roughly 78% on average.
 *   NO_PURCHASE_COST    No factory cost recorded at all. Nothing downstream can
 *                       derive from it — POs autofill blank, landed allocation
 *                       has no base.
 *
 * A product can hit several; it is reported under the worst one only.
 *
 * USAGE
 *   env DATABASE_URL="$(grep ^DATABASE_URL= .env | cut -d= -f2-)" \
 *     ./node_modules/.bin/medusa exec ./src/scripts/checks/check-costs-needing-attention.ts
 *
 *   CHINA_ONLY=true    restrict to China-sourced products
 *   CSV=/path/out.csv  also write the full list as CSV
 */

import { writeFileSync } from "fs";

interface CostRow {
  variant_id: string;
  sku: string | null;
  title: string | null;
  is_china: boolean;
  purchase_cost: string | null;
  average_cost: string | null;
  average_cost_source: string | null;
  qb_avg_cost: string | null;
  stock_miami: string;
  stock_china: string;
  sold_units_90d: string;
  sold_revenue_90d: string;
  vendor_bills: string;
}

type Finding =
  | "NO_AVERAGE_COST"
  | "LANDED_BELOW_PURCHASE"
  | "NO_LANDED_APPLIED"
  | "NO_PURCHASE_COST"
  | "AVERAGE_BELOW_CURRENT_FACTORY";

const SEVERITY: Record<Finding, number> = {
  NO_AVERAGE_COST: 1,
  LANDED_BELOW_PURCHASE: 2,
  NO_LANDED_APPLIED: 3,
  NO_PURCHASE_COST: 4,
  AVERAGE_BELOW_CURRENT_FACTORY: 5,
};

const HEADLINE: Record<Finding, string> = {
  NO_AVERAGE_COST: "SIN COSTO PROMEDIO — vende con COGS $0",
  LANDED_BELOW_PURCHASE: "LANDED POR DEBAJO DE LA FABRICA — imposible, es un bug",
  NO_LANDED_APPLIED: "SIN LANDED APLICADO — promedio = costo de fabrica pelado",
  NO_PURCHASE_COST: "SIN COSTO DE COMPRA",
  AVERAGE_BELOW_CURRENT_FACTORY: "PROMEDIO VIEJO — la fabrica subio desde la ultima compra",
};

const EXPLAIN: Record<Finding, string> = {
  NO_AVERAGE_COST:
    "Cada venta se registra como ganancia pura y el inventario no vale nada en los reportes.",
  LANDED_BELOW_PURCHASE:
    "Este promedio SI salio de un vendor bill, y el landed es fabrica + comision + flete + " +
    "arancel: no puede dar menos que la fabrica. Revisar ese bill.",
  NO_LANDED_APPLIED:
    "Falta comision del agente, flete y arancel. En China eso subestima el COGS ~78%.",
  NO_PURCHASE_COST:
    "Sin base para autollenar POs ni para prorratear el landed de un vendor bill.",
  AVERAGE_BELOW_CURRENT_FACTORY:
    "NO es un error: el promedio refleja compras viejas mas baratas y el precio de fabrica de hoy " +
    "es mayor. Solo confirmar que el costo de fabrica cargado sea el vigente — la proxima compra " +
    "va a subir el promedio sola.",
};

const SQL = `
SELECT pv.id AS variant_id,
       pv.sku,
       p.title,
       COALESCE((p.metadata->>'is_sourced_via_agent') = 'true', false) AS is_china,
       NULLIF(pv.metadata->>'purchase_cost','')  AS purchase_cost,
       NULLIF(pv.metadata->>'average_cost','')   AS average_cost,
       NULLIF(pv.metadata->>'average_cost_source','') AS average_cost_source,
       NULLIF(pv.metadata->>'qb_avg_cost','')    AS qb_avg_cost,
       COALESCE((
         SELECT SUM(il.stocked_quantity) FROM inventory_level il
           JOIN product_variant_inventory_item pvii ON pvii.inventory_item_id = il.inventory_item_id
           JOIN stock_location sl ON sl.id = il.location_id
          WHERE pvii.variant_id = pv.id AND il.deleted_at IS NULL AND sl.name = 'Ecopowertech Miami'
       ), 0)::text AS stock_miami,
       COALESCE((
         SELECT SUM(il.stocked_quantity) FROM inventory_level il
           JOIN product_variant_inventory_item pvii ON pvii.inventory_item_id = il.inventory_item_id
           JOIN stock_location sl ON sl.id = il.location_id
          WHERE pvii.variant_id = pv.id AND il.deleted_at IS NULL AND sl.name = 'China Warehouse'
       ), 0)::text AS stock_china,
       COALESCE((
         SELECT SUM(ii.quantity) FROM pos_invoice_item ii
           JOIN pos_invoice i ON i.id = ii.invoice_id
          WHERE ii.sku = pv.sku AND ii.deleted_at IS NULL AND i.voided_at IS NULL
            AND COALESCE(i.issued_at, i.created_at) >= NOW() - INTERVAL '90 days'
       ), 0)::text AS sold_units_90d,
       COALESCE((
         SELECT SUM(ii.quantity * ii.unit_price) / 100.0 FROM pos_invoice_item ii
           JOIN pos_invoice i ON i.id = ii.invoice_id
          WHERE ii.sku = pv.sku AND ii.deleted_at IS NULL AND i.voided_at IS NULL
            AND COALESCE(i.issued_at, i.created_at) >= NOW() - INTERVAL '90 days'
       ), 0)::text AS sold_revenue_90d,
       COALESCE((
         SELECT count(*) FROM vendor_bill_cost_log l
          WHERE l.product_variant_id = pv.id AND l.reversed_at IS NULL
       ), 0)::text AS vendor_bills
  FROM product_variant pv
  JOIN product p ON p.id = pv.product_id
 WHERE pv.deleted_at IS NULL AND p.deleted_at IS NULL
 ORDER BY pv.sku
`;

const money = (value: number): string =>
  `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function parse(raw: string | null): number | null {
  if (raw === null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Classify one variant. Returns null when the cost basis is healthy.
 *
 * "Similar" is 1 cent, not an exact match: the July backfill copied
 * purchase_cost into average_cost and the factory price has drifted a few cents
 * on some SKUs since, which would hide them from an equality test.
 *
 * The average-below-factory split matters. An average BELOW today's factory
 * price is perfectly normal on its own — the average reflects what was actually
 * paid for the units on hand, and if the factory raised its price since, the old
 * cheap stock is still worth what it cost. It is only IMPOSSIBLE when the
 * average came from a landed calculation that used that same factory price,
 * because landed = factory + commission + freight + duty and cannot come out
 * lower. So the finding is gated on `average_cost_source = 'landed'`; anything
 * else is reported as informational, not as a bug to chase.
 */
function classify(row: CostRow): Finding | null {
  const purchase = parse(row.purchase_cost);
  const average = parse(row.average_cost);
  const cameFromLandedBill =
    row.average_cost_source === "landed" && Number(row.vendor_bills) > 0;

  if (average === null || average <= 0) return "NO_AVERAGE_COST";

  if (purchase !== null && purchase > 0) {
    if (average < purchase - 0.01) {
      return cameFromLandedBill ? "LANDED_BELOW_PURCHASE" : "AVERAGE_BELOW_CURRENT_FACTORY";
    }
    // Only meaningful for China: a local product's average legitimately equals
    // its purchase cost when there are no freight charges to add.
    if (row.is_china && Math.abs(average - purchase) <= 0.01) return "NO_LANDED_APPLIED";
  }

  if (purchase === null || purchase <= 0) return "NO_PURCHASE_COST";
  return null;
}

export default async function checkCostsNeedingAttention({
  container,
}: {
  container: { resolve: (key: string) => unknown };
}) {
  const knex = container.resolve("__pg_connection__") as {
    raw: (sql: string) => Promise<{ rows: CostRow[] }>;
  };
  const chinaOnly = process.env.CHINA_ONLY === "true";

  const { rows } = await knex.raw(SQL);
  const scope = chinaOnly ? rows.filter((row) => row.is_china) : rows;

  const flagged = scope
    .map((row) => ({ row, finding: classify(row) }))
    .filter((entry): entry is { row: CostRow; finding: Finding } => entry.finding !== null)
    .map(({ row, finding }) => {
      const stockMiami = Number(row.stock_miami);
      const stockChina = Number(row.stock_china);
      const soldUnits = Number(row.sold_units_90d);
      const revenue = Number(row.sold_revenue_90d);
      return {
        row,
        finding,
        stockMiami,
        stockChina,
        soldUnits,
        revenue,
        // Ranking: revenue at risk over the last 90 days, plus units sitting on
        // the shelf that are carried at the wrong value. Dormant SKUs sink.
        exposure: revenue + stockMiami * (parse(row.purchase_cost) ?? 0),
      };
    })
    .sort((a, b) => b.exposure - a.exposure);

  console.log("═".repeat(96));
  console.log(`  COSTOS QUE REQUIEREN ATENCION${chinaOnly ? " — solo China" : ""}`);
  console.log("═".repeat(96));
  console.log(
    `  ${scope.length} variantes revisadas · ${flagged.length} con problema · ` +
      `${scope.length - flagged.length} sanas`
  );

  const order: Finding[] = [
    "NO_AVERAGE_COST",
    "LANDED_BELOW_PURCHASE",
    "NO_LANDED_APPLIED",
    "NO_PURCHASE_COST",
    "AVERAGE_BELOW_CURRENT_FACTORY",
  ];

  for (const finding of order.sort((a, b) => SEVERITY[a] - SEVERITY[b])) {
    const group = flagged.filter((entry) => entry.finding === finding);
    if (group.length === 0) continue;

    const active = group.filter((entry) => entry.soldUnits > 0 || entry.stockMiami > 0);
    console.log("");
    console.log("─".repeat(96));
    console.log(`  ${HEADLINE[finding]}  —  ${group.length} productos (${active.length} con stock o ventas)`);
    console.log(`  ${EXPLAIN[finding]}`);
    console.log("─".repeat(96));
    console.log(
      "  SKU".padEnd(26) +
        "fabrica".padStart(10) +
        "promedio".padStart(11) +
        "QB".padStart(10) +
        "stock".padStart(8) +
        "vend90d".padStart(9) +
        "$ 90d".padStart(12) +
        "  bills"
    );

    // Dormant rows are counted but not listed: they are noise until someone
    // actually orders them.
    for (const entry of group.filter((e) => e.soldUnits > 0 || e.stockMiami > 0)) {
      console.log(
        "  " +
          String(entry.row.sku ?? entry.row.variant_id).slice(0, 24).padEnd(24) +
          (parse(entry.row.purchase_cost) ?? 0).toFixed(2).padStart(10) +
          (parse(entry.row.average_cost) ?? 0).toFixed(2).padStart(11) +
          (entry.row.qb_avg_cost === null ? "—" : Number(entry.row.qb_avg_cost).toFixed(2)).padStart(10) +
          String(entry.stockMiami).padStart(8) +
          String(entry.soldUnits).padStart(9) +
          money(entry.revenue).padStart(12) +
          String(entry.row.vendor_bills).padStart(7)
      );
    }
    const dormant = group.length - active.length;
    if (dormant > 0) {
      console.log(`  … y ${dormant} sin stock ni ventas (revisar solo antes de comprarlos)`);
    }
  }

  const bleeding = flagged.filter(
    (entry) => entry.finding === "NO_AVERAGE_COST" && entry.soldUnits > 0
  );
  if (bleeding.length > 0) {
    console.log("");
    console.log("─".repeat(96));
    console.log("  PRIORIDAD — vendiendo HOY sin costo registrado:");
    for (const entry of bleeding) {
      console.log(
        `    ${entry.row.sku}: ${entry.soldUnits} unidades / ${money(entry.revenue)} ` +
          `en 90 dias con COGS $0`
      );
    }
  }

  if (process.env.CSV) {
    const header =
      "finding,sku,title,is_china,purchase_cost,average_cost,average_cost_source,qb_avg_cost," +
      "stock_miami,stock_china,sold_units_90d,revenue_90d,vendor_bills\n";
    const body = flagged
      .map((entry) =>
        [
          entry.finding,
          entry.row.sku ?? "",
          `"${(entry.row.title ?? "").replace(/"/g, '""')}"`,
          entry.row.is_china,
          entry.row.purchase_cost ?? "",
          entry.row.average_cost ?? "",
          entry.row.average_cost_source ?? "",
          entry.row.qb_avg_cost ?? "",
          entry.stockMiami,
          entry.stockChina,
          entry.soldUnits,
          entry.revenue.toFixed(2),
          entry.row.vendor_bills,
        ].join(",")
      )
      .join("\n");
    writeFileSync(process.env.CSV, header + body + "\n");
    console.log("");
    console.log(`CSV escrito en ${process.env.CSV} (${flagged.length} filas)`);
  }

  return {
    reviewed: scope.length,
    flagged: flagged.length,
    byFinding: order.reduce<Record<string, number>>((acc, finding) => {
      acc[finding] = flagged.filter((entry) => entry.finding === finding).length;
      return acc;
    }, {}),
  };
}
