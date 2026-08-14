/**
 * Sección del digest: INVARIANTE DEL WRITE-OFF DE REDONDEO — read-only.
 *
 * Comprueba, todas las noches, que `Σ facturas = aplicado + Σ ajustes` en cada
 * orden tocada por un ajuste vivo. El mecanismo ya hace cumplir esa regla POR
 * FACTURA; esta sección verifica que la deducción a nivel orden se sostenga de
 * verdad — es la comprobación de que el procedimiento es correcto, no el arreglo.
 *
 * Una fila = algo escribió por fuera del chokepoint, o un ajuste quedó huérfano.
 * Se investiga a mano; **nunca se auto-repara**.
 *
 * Silencio = limpio. Sin ajustes o sin desvíos, no se emite sección: una alarma
 * que aparece todos los días sin decir nada se ignora en una semana.
 *
 * Fail-isolated: un error devuelve null y el digest sale igual — un problema de
 * esta auditoría jamás debe tapar los errores de pipeline de QuickBooks.
 * Filename con `_`: el JobLoader excluye por FILENAME, no por directorio.
 */
import { auditRoundingInvariant } from "../../lib/rounding/audit-rounding-invariant";

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

export interface RoundingInvariantSection {
  title: string;
  description: string;
  admin_path: string;
  rows: SectionRow[];
}

const fmt = (cents: number) =>
  `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;

export async function collectRoundingInvariantSection(
  knex: KnexRaw,
  logger: { warn: (m: string) => void }
): Promise<RoundingInvariantSection | null> {
  try {
    const runner = {
      query: async <T,>(sql: string, params?: unknown[]) => {
        const res = await knex.raw<{ rows: T[] }>(sql, (params ?? []) as unknown[]);
        return { rows: res.rows };
      },
    };
    const report = await auditRoundingInvariant(runner);

    // Estado estacionario: cero desvíos. El inventario de lo absorbido no
    // amerita un email por sí solo.
    if (report.findings.length === 0) return null;

    return {
      title: "⚠️ DATA INVARIANT VIOLATION — write-off de redondeo",
      description:
        `Ajustes de redondeo cuyo documento NO cierra. Son dos invariantes, uno por ` +
        `dirección: un shortage tiene que dejar su FACTURA en cero, y un overage tiene ` +
        `que dejar su PAGO consumido. Un desvío acá significa que otro escritor rompió ` +
        `la igualdad o que el ajuste quedó huérfano de su documento. Se investiga a ` +
        `mano; nada se auto-repara. ` +
        `(Ajustes vivos auditados: ${report.cohortSize} · absorbido en total: ` +
        `${fmt(report.absorbedCents)} · definición: lib/rounding/audit-rounding-invariant.ts)`,
      admin_path: "/orders",
      rows: report.findings.map((f) => ({
        id: f.adjustment_id,
        medusa_ref: f.document_id,
        qb_ref: "",
        step: `rounding_${f.direction}`,
        error:
          `gap ${fmt(f.gap_cents)} — ${f.direction === "shortage" ? "factura" : "pago"} ` +
          `${fmt(f.document_cents)} · aplicado ${fmt(f.applied_cents)} · ` +
          `absorbido ${fmt(f.adjusted_cents)}`,
        retries: 0,
        status: "violation",
        created_at: new Date(),
      })),
    };
  } catch (e) {
    logger.warn(
      `[rounding-invariant-section] failed (aislado, el digest sale igual): ${(e as Error).message}`
    );
    return null;
  }
}
