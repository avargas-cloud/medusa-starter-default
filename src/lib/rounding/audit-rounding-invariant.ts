/**
 * src/lib/rounding/audit-rounding-invariant.ts
 *
 * El invariante del write-off de redondeo. Son DOS, uno por dirección, y viven
 * en el documento donde cada ancla vive:
 *
 *     shortage:  factura.total  =  Σ aplicado a esa factura  +  ajuste
 *     overage:   pago.amount    =  Σ aplicado por ese pago   +  ajuste
 *
 * ── Por qué DOS y no uno a nivel orden ────────────────────────────────────────
 * La primera versión de esta auditoría los mezcló en una sola ecuación por orden
 * y produjo dos falsos positivos sobre cuatro filas en la primera corrida contra
 * datos reales:
 *
 *   · un overage marcaba gap 1 porque NO pertenece a la ecuación de la factura —
 *     la factura cerraba perfecto; el sobrante estaba en el pago;
 *   · una orden con una factura legítimamente abierta (8¢ por encima del tope,
 *     rechazados a propósito) marcaba gap 8, que es el mecanismo funcionando.
 *
 * Una alarma con falsos positivos permanentes se ignora en una semana. La
 * cohorte tiene que ser EXACTA, y la exactitud viene de auditar cada dirección
 * en su propio documento.
 *
 * ── Qué significa una fila ────────────────────────────────────────────────────
 * Que algo escribió por fuera del chokepoint, o que un ajuste quedó huérfano de
 * su documento. Se investiga a mano; **jamás se auto-repara** — un centavo mal
 * absorbido es plata del cliente.
 *
 * Sin tolerancia: el estado sano es gap = 0 exacto. Un umbral acá dejaría pasar
 * justo la clase de error que este mecanismo puede introducir.
 */

export interface RoundingInvariantFinding {
  adjustment_id: string;
  direction: "shortage" | "overage";
  /** Documento que tenía que cerrar: la factura o el pago. */
  document_id: string;
  /** Total del documento, en centavos. */
  document_cents: number;
  /** Plata aplicada, en centavos. */
  applied_cents: number;
  /** Monto absorbido, en centavos. */
  adjusted_cents: number;
  /** `documento − aplicado − ajuste`. Cero es el estado sano. */
  gap_cents: number;
}

export interface RoundingInvariantReport {
  /** Ajustes vivos auditados. */
  cohortSize: number;
  /** Total absorbido por el mecanismo, en centavos. */
  absorbedCents: number;
  findings: RoundingInvariantFinding[];
}

export interface SqlRunner {
  query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
}

/**
 * El SQL vive UNA vez y lo comparten el digest y cualquier script. Cuando la
 * definición de un invariante estuvo duplicada en dos literales (el caso del
 * índice `orders`), los dos lados terminaron discrepando sobre qué era deriva.
 */
const INVARIANT_SQL = `
  -- shortage: la FACTURA tiene que cerrar con lo aplicado más lo absorbido.
  SELECT a.id            AS adjustment_id,
         a.direction     AS direction,
         a.invoice_id    AS document_id,
         i.total::int    AS document_cents,
         COALESCE((
           SELECT SUM(pa.amount_applied) FROM payment_application pa
            WHERE pa.invoice_id = i.id
              AND pa.voided_at IS NULL AND pa.deleted_at IS NULL
         ), 0)::int      AS applied_cents,
         a.amount_cents  AS adjusted_cents,
         (i.total
            - COALESCE((
                SELECT SUM(pa.amount_applied) FROM payment_application pa
                 WHERE pa.invoice_id = i.id
                   AND pa.voided_at IS NULL AND pa.deleted_at IS NULL
              ), 0)
            - a.amount_cents)::int AS gap_cents
    FROM pos_rounding_adjustment a
    JOIN pos_invoice i ON i.id = a.invoice_id
   WHERE a.direction = 'shortage'
     AND a.voided_at IS NULL AND a.deleted_at IS NULL
     AND i.voided_at IS NULL AND i.deleted_at IS NULL

  UNION ALL

  -- overage: el PAGO tiene que quedar consumido por lo aplicado más lo absorbido.
  SELECT a.id            AS adjustment_id,
         a.direction     AS direction,
         a.payment_id    AS document_id,
         cp.amount::int  AS document_cents,
         COALESCE((
           SELECT SUM(pa.amount_applied) FROM payment_application pa
            WHERE pa.payment_id = cp.id
              AND pa.voided_at IS NULL AND pa.deleted_at IS NULL
         ), 0)::int      AS applied_cents,
         a.amount_cents  AS adjusted_cents,
         (cp.amount
            - COALESCE((
                SELECT SUM(pa.amount_applied) FROM payment_application pa
                 WHERE pa.payment_id = cp.id
                   AND pa.voided_at IS NULL AND pa.deleted_at IS NULL
              ), 0)
            - a.amount_cents)::int AS gap_cents
    FROM pos_rounding_adjustment a
    JOIN customer_payment cp ON cp.id = a.payment_id
   WHERE a.direction = 'overage'
     AND a.voided_at IS NULL AND a.deleted_at IS NULL
     AND cp.status <> 'voided' AND cp.deleted_at IS NULL
`;

export async function auditRoundingInvariant(
  runner: SqlRunner
): Promise<RoundingInvariantReport> {
  const { rows } = await runner.query<{
    adjustment_id: string;
    direction: "shortage" | "overage";
    document_id: string;
    document_cents: number;
    applied_cents: number;
    adjusted_cents: number;
    gap_cents: number;
  }>(INVARIANT_SQL);

  return {
    cohortSize: rows.length,
    absorbedCents: rows.reduce((t, r) => t + Number(r.adjusted_cents ?? 0), 0),
    findings: rows
      .filter((r) => Number(r.gap_cents) !== 0)
      .map((r) => ({
        adjustment_id: r.adjustment_id,
        direction: r.direction,
        document_id: r.document_id,
        document_cents: Number(r.document_cents),
        applied_cents: Number(r.applied_cents),
        adjusted_cents: Number(r.adjusted_cents),
        gap_cents: Number(r.gap_cents),
      })),
  };
}
