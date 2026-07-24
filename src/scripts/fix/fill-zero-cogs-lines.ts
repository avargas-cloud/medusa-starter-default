/**
 * Give a cost to sale lines that were booked with none.
 *
 * A line with `average_unit_cost` of 0 or NULL reports as pure profit: the sale
 * shows full revenue against nothing. It happens when a product's cost basis is
 * missing at the moment of sale — which is exactly what the 2026-07-17 backfill
 * caused, and what the restatement could not repair, because a run that has no
 * cost to work from correctly refuses to invent one (writing a zero would be
 * worse than leaving the gap visible).
 *
 * Once the cost EXISTS — filled from QuickBooks, entered by hand, or landed by a
 * vendor bill — those lines can finally be priced. This does that, and only
 * that.
 *
 * WHY NOT JUST RE-RUN THE RESTATEMENT
 * The restatement reprices a variant's WHOLE history from its timeline. For
 * these lines that would be worse, not better: ENEA1-18-30's April sales carry
 * $18.45267, a real snapshot of what the cost was in April, while the only
 * broken line is from 20 July. Repricing all eight to today's figure would
 * overwrite seven correct April costs to fix one July gap. So this fills the
 * gap and leaves every line that already has a cost alone.
 *
 * The cost used is the variant's CURRENT `average_cost`. That is an
 * approximation and the audit row says so (`reason_code`): it is the cost as of
 * today, not as of the sale. For a sale a few days old that is the closest
 * evidence available; for an old one, prefer entering the figure by hand.
 *
 * Every change still lands in `sale_cost_adjustment` under a named run, and
 * every write is compare-and-swap, exactly like the restatement.
 *
 * USAGE
 *   env DATABASE_URL="$(grep ^DATABASE_URL= .env | cut -d= -f2-)" \
 *     ./node_modules/.bin/medusa exec ./src/scripts/fix/fill-zero-cogs-lines.ts
 *
 *   APPLY=true RUN_ID=zc_2026_07_24  write the fills
 *   MAX_AGE_DAYS=60                  refuse lines older than this (default 90)
 */

interface ZeroCostLine {
  source_type: "invoice_item" | "credit_memo_item";
  line_id: string;
  document_id: string;
  document_number: string | null;
  variant_id: string;
  sku: string | null;
  quantity: number | string;
  economic_posted_at: string;
  average_cost: string | null;
  age_days: number | string;
}

/**
 * Sale lines with no cost, whose variant NOW has one. Invoices and credit memos
 * in one shape so both get the same treatment.
 */
const ZERO_COST_SQL = `
WITH costed AS (
  SELECT pv.id, pv.sku, NULLIF(pv.metadata->>'average_cost','')::numeric AS average_cost
    FROM product_variant pv
   WHERE pv.deleted_at IS NULL
     AND NULLIF(pv.metadata->>'average_cost','')::numeric > 0
)
SELECT 'invoice_item' AS source_type, ii.id AS line_id, i.id AS document_id,
       i.invoice_number AS document_number, c.id AS variant_id, ii.sku, ii.quantity,
       COALESCE(i.issued_at, i.created_at) AS economic_posted_at,
       c.average_cost::text AS average_cost,
       EXTRACT(day FROM NOW() - COALESCE(i.issued_at, i.created_at))::int AS age_days
  FROM pos_invoice_item ii
  JOIN pos_invoice i ON i.id = ii.invoice_id
  JOIN costed c ON c.sku = ii.sku
 WHERE ii.deleted_at IS NULL AND i.deleted_at IS NULL AND i.voided_at IS NULL
   AND COALESCE(ii.average_unit_cost, 0) = 0
   AND ii.quantity <> 0

UNION ALL

SELECT 'credit_memo_item', cmi.id, cm.id, cm.id, c.id, cmi.sku, cmi.quantity,
       COALESCE(cm.completed_at, cm.created_at),
       c.average_cost::text,
       EXTRACT(day FROM NOW() - COALESCE(cm.completed_at, cm.created_at))::int
  FROM pos_credit_memo_item cmi
  JOIN pos_credit_memo cm ON cm.id = cmi.credit_memo_id
  JOIN costed c ON c.sku = cmi.sku
 WHERE cmi.deleted_at IS NULL AND cm.deleted_at IS NULL AND cm.voided_at IS NULL
   AND COALESCE(cmi.average_unit_cost, 0) = 0
   AND cmi.quantity <> 0

ORDER BY economic_posted_at
`;

const num = (raw: unknown): number => {
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
};

/**
 * A timestamptz comes back from knex as a Date, not a string — calling .slice()
 * on it throws. Normalise both shapes to an ISO string.
 */
const iso = (raw: unknown): string =>
  raw instanceof Date ? raw.toISOString() : String(raw ?? "");

/** Stable id so a retried apply reuses the row instead of duplicating it. */
function adjustmentId(runId: string, sourceType: string, lineId: string): string {
  let h1 = 0x811c9dc5;
  const input = `${runId}:${sourceType}:${lineId}`;
  for (let i = 0; i < input.length; i++) {
    h1 = Math.imul(h1 ^ input.charCodeAt(i), 0x01000193) >>> 0;
  }
  return `sca_zc_${h1.toString(36)}${lineId.slice(-6)}`;
}

export default async function fillZeroCogsLines({
  container,
}: {
  container: { resolve: (key: string) => unknown };
}) {
  const knex = container.resolve("__pg_connection__") as {
    raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: any[]; rowCount?: number }>;
    transaction: <T>(handler: (trx: any) => Promise<T>) => Promise<T>;
  };

  const apply = process.env.APPLY === "true";
  const maxAgeDays = Number(process.env.MAX_AGE_DAYS ?? 90);
  const runId = process.env.RUN_ID ?? `zc_dryrun_${new Date().toISOString().slice(0, 10)}`;

  const { rows } = await knex.raw(ZERO_COST_SQL);
  const lines = rows as ZeroCostLine[];

  // SKUS restricts the fill to an explicit list. The finding is usually wider
  // than the ask — the first production run surfaced 40 zero-cost lines across
  // the whole catalog when only two were being chased — and quietly repricing
  // the rest is not this script's call to make.
  const skuFilter = (process.env.SKUS ?? "")
    .split(",")
    .map((sku) => sku.trim())
    .filter(Boolean);
  const inScope =
    skuFilter.length > 0 ? lines.filter((line) => skuFilter.includes(line.sku ?? "")) : lines;
  if (skuFilter.length > 0) {
    console.log(`  filtro SKUS  ${skuFilter.join(", ")} → ${inScope.length} de ${lines.length} líneas`);
  }

  const eligible = inScope.filter((line) => num(line.age_days) <= maxAgeDays);
  const tooOld = inScope.filter((line) => num(line.age_days) > maxAgeDays);

  console.log("═".repeat(94));
  console.log("  LINEAS VENDIDAS SIN COSTO (COGS $0)");
  console.log("═".repeat(94));
  console.log(`  modo        ${apply ? "APPLY" : "DRY RUN"}`);
  console.log(`  run id      ${runId}`);
  console.log(`  antigüedad  máximo ${maxAgeDays} días (el costo usado es el de HOY)`);
  console.log("");

  if (lines.length === 0) {
    console.log("  No hay líneas con COGS $0 cuyo producto tenga costo. Nada que hacer.");
    return { found: 0, filled: 0 };
  }

  console.log(
    "  documento".padEnd(16) +
      "SKU".padEnd(20) +
      "fecha".padEnd(12) +
      "cant".padStart(6) +
      "costo a aplicar".padStart(17) +
      "COGS".padStart(11)
  );
  let totalCogs = 0;
  for (const line of eligible) {
    const cost = num(line.average_cost);
    const quantity = num(line.quantity);
    totalCogs += cost * quantity;
    console.log(
      "  " +
        String(line.document_number ?? line.document_id).slice(0, 14).padEnd(14) +
        String(line.sku ?? "").slice(0, 18).padEnd(20) +
        iso(line.economic_posted_at).slice(0, 10).padEnd(12) +
        String(quantity).padStart(6) +
        cost.toFixed(4).padStart(17) +
        (cost * quantity).toFixed(2).padStart(11)
    );
  }

  console.log("");
  console.log(`  ${eligible.length} líneas · COGS a registrar $${totalCogs.toFixed(2)}`);
  if (tooOld.length > 0) {
    console.log(
      `  ⚠ ${tooOld.length} líneas EXCLUIDAS por tener más de ${maxAgeDays} días — el costo de hoy ` +
        `no las representa. Cargar a mano o subir MAX_AGE_DAYS a conciencia.`
    );
    for (const line of tooOld) {
      console.log(
        `      ${line.document_number ?? line.document_id} · ${line.sku} · ` +
          `${iso(line.economic_posted_at).slice(0, 10)} (${num(line.age_days)} días)`
      );
    }
  }

  if (!apply) {
    console.log("");
    console.log("DRY RUN — no se escribió nada. APPLY=true y RUN_ID=<id> para aplicar.");
    return { found: lines.length, eligible: eligible.length, filled: 0, dryRun: true };
  }
  if (!process.env.RUN_ID) {
    throw new Error("APPLY=true requiere RUN_ID explícito para que quede auditable.");
  }
  if (eligible.length === 0) {
    console.log("Nada elegible para escribir.");
    return { found: lines.length, eligible: 0, filled: 0 };
  }

  const filled = await knex.transaction(async (trx) => {
    // Audit row first — the pre-fill state survives even if the update fails.
    await trx.raw(
      `INSERT INTO sale_cost_adjustment
         (id, restatement_run_id, source_type, source_line_id, source_document_id,
          product_variant_id, sku, quantity, original_unit_cost, prior_restated_unit_cost,
          new_restated_unit_cost, original_extended_cogs, new_extended_cogs, delta_cogs,
          economic_posted_at, reason_code)
       SELECT u.id, ?, u.source_type, u.line_id, u.document_id, u.variant_id, u.sku,
              u.quantity, 0, 0, u.new_cost, 0, u.new_cost * u.quantity,
              u.new_cost * u.quantity, u.posted_at::timestamptz,
              'zero_cogs_filled_at_current_cost'
         FROM UNNEST(?::text[], ?::text[], ?::text[], ?::text[], ?::text[], ?::text[],
                     ?::int[], ?::numeric[], ?::text[])
              AS u(id, source_type, line_id, document_id, variant_id, sku,
                   quantity, new_cost, posted_at)
       ON CONFLICT (restatement_run_id, source_type, source_line_id) DO NOTHING`,
      [
        runId,
        eligible.map((l) => adjustmentId(runId, l.source_type, l.line_id)),
        eligible.map((l) => l.source_type),
        eligible.map((l) => l.line_id),
        eligible.map((l) => l.document_id),
        eligible.map((l) => l.variant_id),
        eligible.map((l) => l.sku),
        eligible.map((l) => num(l.quantity)),
        eligible.map((l) => num(l.average_cost)),
        eligible.map((l) => iso(l.economic_posted_at)),
      ]
    );

    let total = 0;
    for (const table of ["pos_invoice_item", "pos_credit_memo_item"] as const) {
      const sourceType = table === "pos_invoice_item" ? "invoice_item" : "credit_memo_item";
      const group = eligible.filter((line) => line.source_type === sourceType);
      if (group.length === 0) continue;

      // Compare-and-swap on "still has no cost": if anything gave the line a
      // cost since the plan was read, it does not match and the count is short.
      const result = await trx.raw(
        `UPDATE ${table} AS t
            SET average_unit_cost = u.new_cost,
                raw_average_unit_cost = jsonb_build_object('value', u.new_cost),
                average_unit_cost_synced_at = NOW(),
                updated_at = NOW()
           FROM UNNEST(?::text[], ?::numeric[]) AS u(line_id, new_cost)
          WHERE t.id = u.line_id
            AND t.deleted_at IS NULL
            AND COALESCE(t.average_unit_cost, 0) = 0`,
        [group.map((l) => l.line_id), group.map((l) => num(l.average_cost))]
      );

      const applied = result.rowCount ?? 0;
      if (applied !== group.length) {
        throw new Error(
          `${table}: se esperaba actualizar ${group.length} líneas, coincidieron ${applied}. ` +
            `Alguna dejó de estar en cero después de leer el plan — rollback.`
        );
      }
      total += applied;
    }
    return total;
  });

  console.log("");
  console.log(`✅ ${filled} líneas con costo, auditadas bajo el run ${runId}.`);
  return { found: lines.length, eligible: eligible.length, filled };
}
