/**
 * Ask QuickBooks what it currently holds for the products whose cost basis is
 * missing or suspect, and report what could be filled in.
 *
 * WHY THIS IS A DIFFERENT QUESTION FROM THE RESTATEMENT
 * The restatement anchored on the QuickBooks average as it stood on 2026-04-14,
 * on purpose: using today's figure as an OPENING balance would have counted
 * every purchase made since then twice. Filling a missing cost TODAY is the
 * opposite problem — here the current QuickBooks value is exactly what we want,
 * because every purchase since April was posted through QuickBooks, so anything
 * bought since then is already reflected in its average.
 *
 * READ-ONLY. It queries the bridge and prints. Nothing is written anywhere; the
 * apply step is a deliberate second decision (`APPLY=true`), and even then it
 * only fills values that are ABSENT — it never overwrites a cost that the
 * restatement computed from a real vendor bill, because our landed figure is
 * built from the actual freight and commission breakdown and QuickBooks' is not.
 *
 * USAGE
 *   env DATABASE_URL="$(grep ^DATABASE_URL= .env | cut -d= -f2-)" \
 *     ./node_modules/.bin/medusa exec ./src/scripts/checks/fetch-qb-costs-for-missing.ts
 *
 *   APPLY=true   fill the absent values (average_cost and/or purchase_cost)
 */

import { fetchQbAverageCostItems } from "../../lib/quickbooks/sync-average-cost-core";

interface CandidateRow {
  variant_id: string;
  sku: string | null;
  quickbooks_id: string | null;
  purchase_cost: string | null;
  average_cost: string | null;
  average_cost_source: string | null;
  qb_avg_cost: string | null;
  stock_miami: string;
  vendor_bills: string;
}

/**
 * The products worth asking about: no average cost, no purchase cost, or an
 * average that is just the raw factory price with no landed component. A
 * variant whose cost came from a real vendor bill is deliberately excluded —
 * ours is better than QuickBooks' there.
 */
const CANDIDATES_SQL = `
SELECT pv.id AS variant_id,
       pv.sku,
       NULLIF(pv.metadata->>'quickbooks_id','')  AS quickbooks_id,
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
         SELECT count(*) FROM vendor_bill_cost_log l
          WHERE l.product_variant_id = pv.id AND l.reversed_at IS NULL
       ), 0)::text AS vendor_bills
  FROM product_variant pv
  JOIN product p ON p.id = pv.product_id
 WHERE pv.deleted_at IS NULL AND p.deleted_at IS NULL
   AND COALESCE((p.metadata->>'is_sourced_via_agent') = 'true', false)
   AND NULLIF(pv.metadata->>'quickbooks_id','') IS NOT NULL
   AND (
        NULLIF(pv.metadata->>'average_cost','')::numeric IS NULL
     OR NULLIF(pv.metadata->>'average_cost','')::numeric <= 0
     OR NULLIF(pv.metadata->>'purchase_cost','')::numeric IS NULL
     OR NULLIF(pv.metadata->>'purchase_cost','')::numeric <= 0
     OR (
          COALESCE(pv.metadata->>'average_cost_source','') <> 'landed'
          AND abs(NULLIF(pv.metadata->>'average_cost','')::numeric
                  - NULLIF(pv.metadata->>'purchase_cost','')::numeric) <= 0.01
        )
   )
 ORDER BY pv.sku
`;

/**
 * Coerce anything money-shaped to a number. The bridge hands QuickBooks amounts
 * back as STRINGS even where the parsed type says number, so calling .toFixed()
 * on them throws — the same trap that money fields out of query.graph set.
 * Everything numeric in this file goes through here.
 */
const parse = (raw: unknown): number | null => {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
};
const show = (value: number | null): string => (value === null ? "—" : value.toFixed(4));

export default async function fetchQbCostsForMissing({
  container,
}: {
  container: { resolve: (key: string) => unknown };
}) {
  const knex = container.resolve("__pg_connection__") as {
    raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: any[]; rowCount?: number }>;
  };
  const apply = process.env.APPLY === "true";

  const { rows } = await knex.raw(CANDIDATES_SQL);
  const candidates = rows as CandidateRow[];
  console.log(`${candidates.length} productos de China con costo faltante o sospechoso.`);
  console.log("Consultando QuickBooks en vivo (solo lectura)…");
  console.log("");

  const { items } = await fetchQbAverageCostItems((line) => console.log(`  ${line}`));
  const qbByListId = new Map(items.map((item) => [item.ListID, item]));

  console.log("");
  console.log("═".repeat(104));
  console.log("  LO QUE QUICKBOOKS TIENE HOY");
  console.log("═".repeat(104));
  console.log(
    "  SKU".padEnd(26) +
      "avg nuestro".padStart(13) +
      "avg QB hoy".padStart(13) +
      "compra nuestra".padStart(16) +
      "compra QB".padStart(12) +
      "stock".padStart(8) +
      "  accion"
  );

  const fills: Array<{
    variantId: string;
    sku: string | null;
    averageCost: number | null;
    purchaseCost: number | null;
  }> = [];
  let stillMissing = 0;

  for (const row of candidates) {
    const qb = row.quickbooks_id ? qbByListId.get(row.quickbooks_id) : undefined;
    const ourAverage = parse(row.average_cost);
    const ourPurchase = parse(row.purchase_cost);
    const qbAverage = parse(qb?.AverageCost);
    const qbPurchase = parse(qb?.PurchaseCost);

    // Only ever FILL a gap. A cost that came from a vendor bill stays: it was
    // built from the real freight and commission split, which QuickBooks does
    // not have.
    const fillAverage =
      (ourAverage === null || ourAverage <= 0) && qbAverage !== null && qbAverage > 0
        ? qbAverage
        : null;
    const fillPurchase =
      (ourPurchase === null || ourPurchase <= 0) && qbPurchase !== null && qbPurchase > 0
        ? qbPurchase
        : null;

    let action: string;
    if (!qb) {
      action = "no está en la respuesta de QB";
      stillMissing++;
    } else if (fillAverage === null && fillPurchase === null) {
      action =
        qbAverage !== null && ourAverage !== null && Math.abs(qbAverage - ourAverage) > 0.01
          ? "QB difiere — revisar a mano"
          : "QB no aporta nada nuevo";
      if (fillAverage === null && (ourAverage === null || ourAverage <= 0)) stillMissing++;
    } else {
      const parts: string[] = [];
      if (fillAverage !== null) parts.push(`avg → ${fillAverage.toFixed(4)}`);
      if (fillPurchase !== null) parts.push(`compra → ${fillPurchase.toFixed(4)}`);
      action = `RELLENAR ${parts.join(" · ")}`;
      fills.push({
        variantId: row.variant_id,
        sku: row.sku,
        averageCost: fillAverage,
        purchaseCost: fillPurchase,
      });
    }

    console.log(
      "  " +
        String(row.sku ?? row.variant_id).slice(0, 24).padEnd(24) +
        show(ourAverage).padStart(13) +
        show(qbAverage).padStart(13) +
        show(ourPurchase).padStart(16) +
        show(qbPurchase).padStart(12) +
        String(Number(row.stock_miami)).padStart(8) +
        "  " +
        action
    );
  }

  console.log("");
  console.log(`  ${fills.length} se pueden rellenar desde QuickBooks.`);
  console.log(`  ${stillMissing} siguen sin costo en ningún lado — carga manual.`);

  if (!apply) {
    console.log("");
    console.log("DRY RUN — no se escribió nada. APPLY=true para rellenar.");
    return { candidates: candidates.length, fillable: fills.length, stillMissing, applied: 0 };
  }

  if (fills.length === 0) {
    console.log("Nada para escribir.");
    return { candidates: candidates.length, fillable: 0, stillMissing, applied: 0 };
  }

  // JSONB merge, and only the keys that are actually being filled — a variant
  // getting a purchase cost must not have its average blanked, and vice versa.
  const result = await knex.raw(
    `UPDATE product_variant AS pv
        SET metadata = COALESCE(pv.metadata, '{}'::jsonb)
                       || CASE WHEN u.average_cost IS NULL THEN '{}'::jsonb
                               ELSE jsonb_build_object(
                                 'average_cost', u.average_cost,
                                 'average_cost_source', 'sync'::text,
                                 'average_cost_updated_at', now()::text) END
                       || CASE WHEN u.purchase_cost IS NULL THEN '{}'::jsonb
                               ELSE jsonb_build_object('purchase_cost', u.purchase_cost) END,
            updated_at = NOW()
       FROM UNNEST(?::text[], ?::float[], ?::float[]) AS u(variant_id, average_cost, purchase_cost)
      WHERE pv.id = u.variant_id AND pv.deleted_at IS NULL`,
    [
      fills.map((f) => f.variantId),
      fills.map((f) => f.averageCost),
      fills.map((f) => f.purchaseCost),
    ]
  );

  console.log("");
  console.log(`✅ ${result.rowCount ?? 0} variantes actualizadas desde QuickBooks.`);
  return {
    candidates: candidates.length,
    fillable: fills.length,
    stillMissing,
    applied: result.rowCount ?? 0,
  };
}
