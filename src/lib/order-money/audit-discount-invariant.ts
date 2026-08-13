/**
 * Auditoría del invariante de descuento — READ-ONLY, sin auto-heal.
 *
 * El invariante (descuentos-canonicos-v1): el descuento de una orden tiene UNA
 * representación canónica — metadata (5 claves) + adjustments + link — escrita
 * por `applyOrderDiscount` en una transacción. Esta auditoría denuncia toda
 * orden donde las dos mitades NO coincidan, sin importar quién escribió.
 *
 * Dos cohortes, jamás mezcladas:
 *  - CANÓNICA (`metadata.discount_schema = 1`): contrato EXACTO, sin
 *    tolerancia — el mismo chokepoint escribió ambas mitades en integer
 *    cents, así que un centavo de diferencia es una regresión real, no una
 *    convención vieja.
 *  - LEGACY (sin marker): reporte de clasificación aparte. Ahí viven los
 *    drafts de la era E2146 y las confirmadas pre-chokepoint; se reportan
 *    como inventario, nunca como alarma (una alarma con 36 falsos positivos
 *    permanentes se ignora en una semana, ver drift-log 2026-07).
 *
 * La definición de "adjustment efectivo" es LA MISMA del chokepoint y de
 * order-tax-lines (más nuevo por item+code, versión actual, redondeo por
 * línea) — dos copias de esa definición ya divergieron una vez en 3 campos.
 */
export interface DiscountInvariantFinding {
  display_id: string;
  order_id: string;
  cohort: "canonical" | "legacy";
  problem: string;
  declared: string | null;
  adjustments: string;
  links: number;
}

export interface DiscountInvariantReport {
  canonicalChecked: number;
  canonicalFindings: DiscountInvariantFinding[];
  legacyWithAdjustments: number;
  legacyFindings: DiscountInvariantFinding[];
}

interface Runner {
  query: <T = any>(sql: string, params?: any[]) => Promise<{ rows: T[] }>;
}

const EFFECTIVE_ADJ_SQL = `
  SELECT oi2.order_id,
         ROUND(SUM(line_adj.line_cents))::bigint AS adj_cents,
         COUNT(*) FILTER (WHERE line_adj.line_cents > 0) AS adj_lines
    FROM (
      SELECT a.item_id,
             SUM(ROUND(a.amount * 100)) AS line_cents
        FROM (
          SELECT DISTINCT ON (a.item_id, a.code) a.item_id, a.code, a.amount
            FROM order_line_item_adjustment a
           WHERE a.deleted_at IS NULL
           ORDER BY a.item_id, a.code, a.updated_at DESC, a.id DESC
        ) a
       GROUP BY a.item_id
    ) line_adj
    JOIN (SELECT DISTINCT item_id, order_id FROM order_item WHERE deleted_at IS NULL) oi2
      ON oi2.item_id = line_adj.item_id
   GROUP BY oi2.order_id
`;

export async function auditDiscountInvariant(
  db: Runner
): Promise<DiscountInvariantReport> {
  // ── Cohorte canónica: exacta ────────────────────────────────────────────────
  const { rows: canonical } = await db.query<{
    display_id: string;
    order_id: string;
    m_amount: string | null;
    m_type: string | null;
    m_value: string | null;
    m_code: string | null;
    adj_cents: string | null;
    links: string;
  }>(`
    WITH adj AS (${EFFECTIVE_ADJ_SQL})
    SELECT o.display_id::text, o.id AS order_id,
           o.metadata->>'pos_discount_amount' AS m_amount,
           o.metadata->>'discount_type'  AS m_type,
           o.metadata->>'discount_value' AS m_value,
           o.metadata->>'promotion_code' AS m_code,
           adj.adj_cents::text,
           (SELECT count(*) FROM order_promotion op WHERE op.order_id = o.id)::text AS links
      FROM "order" o
      LEFT JOIN adj ON adj.order_id = o.id
     WHERE o.deleted_at IS NULL
       AND o.metadata->>'discount_schema' = '1'
  `);

  const canonicalFindings: DiscountInvariantFinding[] = [];
  for (const r of canonical) {
    const declaredCents = Math.round(Number(r.m_amount ?? 0) * 100);
    const adjCents = Number(r.adj_cents ?? 0);
    const links = Number(r.links);
    const problems: string[] = [];
    if (declaredCents !== adjCents) {
      problems.push(
        `declarado ${declaredCents}¢ ≠ adjustments ${adjCents}¢ (EXACTO, sin tolerancia)`
      );
    }
    if (declaredCents > 0) {
      if (!r.m_type || !r.m_value || !r.m_code)
        problems.push("descuento > 0 con claves incompletas");
      if (links !== 1) problems.push(`links order_promotion = ${links} (esperado 1)`);
    } else {
      if (r.m_type !== null || r.m_value !== null)
        problems.push("sin descuento pero type/value no-null");
      if (links !== 0) problems.push(`links order_promotion = ${links} (esperado 0)`);
    }
    for (const problem of problems) {
      canonicalFindings.push({
        display_id: r.display_id,
        order_id: r.order_id,
        cohort: "canonical",
        problem,
        declared: r.m_amount,
        adjustments: String(adjCents / 100),
        links,
      });
    }
  }

  // ── Cohorte legacy: inventario, no alarma ───────────────────────────────────
  const { rows: legacy } = await db.query<{
    display_id: string;
    order_id: string;
    m_amount: string | null;
    adj_cents: string;
    links: string;
    is_draft: boolean;
  }>(`
    WITH adj AS (${EFFECTIVE_ADJ_SQL})
    SELECT o.display_id::text, o.id AS order_id,
           o.metadata->>'pos_discount_amount' AS m_amount,
           adj.adj_cents::text, o.is_draft_order AS is_draft,
           (SELECT count(*) FROM order_promotion op WHERE op.order_id = o.id)::text AS links
      FROM adj
      JOIN "order" o ON o.id = adj.order_id
     WHERE o.deleted_at IS NULL
       AND COALESCE(o.metadata->>'discount_schema','') <> '1'
       AND adj.adj_cents <> 0
  `);
  const legacyFindings: DiscountInvariantFinding[] = legacy
    .filter((r) => {
      const declared = r.m_amount == null ? null : Math.round(Number(r.m_amount) * 100);
      return declared === null || declared !== Number(r.adj_cents);
    })
    .map((r) => ({
      display_id: r.display_id,
      order_id: r.order_id,
      cohort: "legacy" as const,
      problem: r.is_draft
        ? "draft legacy con adjustments sin declaración coincidente"
        : "orden legacy: adjustments ≠ declaración (pre-chokepoint)",
      declared: r.m_amount,
      adjustments: String(Number(r.adj_cents) / 100),
      links: Number(r.links),
    }));

  return {
    canonicalChecked: canonical.length,
    canonicalFindings,
    legacyWithAdjustments: legacy.length,
    legacyFindings,
  };
}
