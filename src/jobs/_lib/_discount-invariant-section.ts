/**
 * Sección del digest: VIOLACIÓN DEL INVARIANTE DE DESCUENTO — read-only.
 *
 * El invariante (descuentos-canonicos-v1): metadata + adjustments + link de
 * una orden canónica (`discount_schema=1`) coinciden EXACTO, porque los
 * escribió `applyOrderDiscount` en una transacción. Una fila acá significa que
 * OTRO escritor violó el contrato (ruta nativa de Medusa, script, feature
 * nueva sin chokepoint) — se investiga, jamás se auto-repara.
 *
 * La cohorte LEGACY (sin marker) NO entra a la alarma: son drafts de la era
 * E2146 y confirmadas pre-chokepoint; su conteo va en la descripción como
 * inventario. Una alarma con falsos positivos permanentes se ignora en una
 * semana (lección del drift-log 2026-07).
 *
 * Fail-isolated: un error devuelve null y el digest sale igual. Filename con
 * `_`: el JobLoader excluye por FILENAME, no por directorio.
 */
import { auditDiscountInvariant } from "../../lib/order-money/audit-discount-invariant";

interface KnexRaw {
  raw: <T = { rows: unknown[] }>(sql: string, bindings?: unknown[]) => Promise<T>;
}

interface SectionRow {
  id: string;
  medusa_ref: string;
  qb_ref: string;
  step: string;
  error: string;
  retries: number;
  status: string;
  created_at: string | Date;
}

export interface DiscountInvariantSection {
  title: string;
  description: string;
  admin_path: string;
  rows: SectionRow[];
}

export async function collectDiscountInvariantSection(
  knex: KnexRaw,
  logger: { warn: (m: string) => void }
): Promise<DiscountInvariantSection | null> {
  try {
    const runner = {
      query: async <T,>(sql: string, params?: unknown[]) => {
        const res = await knex.raw<{ rows: T[] }>(
          // knex.raw usa `?`; el auditor no bindea params (SQL estático).
          sql,
          (params ?? []) as unknown[]
        );
        return { rows: res.rows };
      },
    };
    const report = await auditDiscountInvariant(runner);

    if (report.canonicalFindings.length === 0) {
      // Estado estacionario: silencio = limpio. El inventario legacy no
      // amerita email por sí solo.
      return null;
    }

    return {
      title: "⚠️ DATA INVARIANT VIOLATION — descuento de orden (canónico)",
      description:
        `Órdenes canónicas (discount_schema=1) cuyo metadata y adjustments NO coinciden — ` +
        `otro escritor violó el contrato del chokepoint. Se investiga a mano; nada se auto-repara. ` +
        `(Canónicas auditadas: ${report.canonicalChecked} · inventario legacy con adjustments: ${report.legacyWithAdjustments}, ` +
        `clasificación: compare-discount-allocation.ts / audit-discount-invariant.ts)`,
      admin_path: "/orders",
      rows: report.canonicalFindings.map((f) => ({
        id: f.order_id,
        medusa_ref: `#${f.display_id}`,
        qb_ref: "",
        step: "discount_invariant",
        error: `${f.problem} (declarado=$${f.declared ?? "∅"} · adjustments=$${f.adjustments} · links=${f.links})`,
        retries: 0,
        status: "violation",
        created_at: new Date(),
      })),
    };
  } catch (e) {
    logger.warn(
      `[discount-invariant-section] failed (aislado, el digest sale igual): ${(e as Error).message}`
    );
    return null;
  }
}
