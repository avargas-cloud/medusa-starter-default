/**
 * Sección del digest: ORDER COMMISSIONS — read-only.
 *
 * Tres vigilancias, todas manuales (nada se auto-repara):
 *
 * 1. CLEARING ROTA: un settlement store_credit con el CHECK confirmado y el
 *    PAYMENT sin confirmar por >2h. Es el proxy DB del invariante contable
 *    "Referral Commission Clearing = $0": el check ya sacó plata de la clearing
 *    y el payment que la devuelve no llegó — la cuenta queda desbalanceada en
 *    QuickBooks hasta que alguien lo mire.
 * 2. LIQUIDACIÓN ATASCADA: settlement pending/qb_waiting >24h (bill que nunca
 *    confirmó, fila de pipeline muerta, etc.).
 * 3. CLAWBACK MANUAL (§2.6 del plan — el clawback automático quedó FUERA de
 *    v1): un credit memo vivo creado DESPUÉS de liquidar una comisión de esa
 *    orden. La base ya no es la que se comisionó; un humano decide si se
 *    recupera contra la próxima comisión. El histórico nunca se edita.
 *
 * Silencio = limpio. Fail-isolated: un error devuelve null y el digest sale
 * igual. Filename con `_`: el JobLoader excluye por FILENAME, no por directorio.
 */

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

export interface CommissionInvariantSection {
  title: string;
  description: string;
  admin_path: string;
  rows: SectionRow[];
}

const fmt = (cents: number) => `$${(Math.abs(cents) / 100).toFixed(2)}`;

export async function collectCommissionInvariantSection(
  knex: KnexRaw,
  logger: { warn: (m: string) => void }
): Promise<CommissionInvariantSection | null> {
  try {
    const rows: SectionRow[] = [];

    // 1 · Clearing rota: check confirmado, payment ausente >2h.
    const { rows: clearingRows } = await knex.raw<{
      rows: Array<{
        id: string;
        amount_cents: string;
        qb_check_txn_id: string;
        display_name: string;
        updated_at: Date;
      }>;
    }>(`
      SELECT s.id, s.amount_cents, s.qb_check_txn_id, r.display_name, s.updated_at
        FROM commission_settlement s
        JOIN order_commission_recipient r ON r.id = s.recipient_id
       WHERE s.method = 'store_credit'
         AND s.qb_check_txn_id IS NOT NULL
         AND s.status <> 'confirmed'
         AND s.updated_at < NOW() - INTERVAL '2 hours'
    `);
    for (const r of clearingRows) {
      rows.push({
        id: r.id,
        medusa_ref: r.display_name,
        qb_ref: r.qb_check_txn_id,
        step: "commission_clearing_open",
        error:
          `CLEARING DESBALANCEADA: el check por ${fmt(parseInt(r.amount_cents, 10))} ` +
          `salió de la clearing y el payment que la devuelve no confirmó. ` +
          `Revisar la fila commission_payment del pipeline.`,
        retries: 0,
        status: "violation",
        created_at: r.updated_at,
      });
    }

    // 2 · Liquidaciones atascadas >24h.
    const { rows: stuckRows } = await knex.raw<{
      rows: Array<{
        id: string;
        method: string;
        status: string;
        amount_cents: string;
        display_name: string;
        created_at: Date;
      }>;
    }>(`
      SELECT s.id, s.method, s.status, s.amount_cents, r.display_name, s.created_at
        FROM commission_settlement s
        JOIN order_commission_recipient r ON r.id = s.recipient_id
       WHERE s.status IN ('pending', 'qb_waiting')
         AND s.created_at < NOW() - INTERVAL '24 hours'
         AND s.qb_check_txn_id IS NULL
    `);
    for (const r of stuckRows) {
      rows.push({
        id: r.id,
        medusa_ref: r.display_name,
        qb_ref: "",
        step: `commission_stuck_${r.method}`,
        error: `Liquidación ${r.method} en '${r.status}' hace >24h por ${fmt(parseInt(r.amount_cents, 10))}.`,
        retries: 0,
        status: "stuck",
        created_at: r.created_at,
      });
    }

    // 3 · Refund posterior a una comisión liquidada → clawback manual.
    const { rows: clawbackRows } = await knex.raw<{
      rows: Array<{
        recipient_id: string;
        display_name: string;
        order_display_id: string | null;
        settled_at: Date;
        cm_number: string | null;
        cm_total: string | null;
        cm_created_at: Date;
      }>;
    }>(`
      SELECT r.id AS recipient_id, r.display_name, o.display_id::text AS order_display_id,
             r.settled_at, cm.credit_memo_number AS cm_number, cm.total::text AS cm_total,
             cm.created_at AS cm_created_at
        FROM order_commission_recipient r
        JOIN order_commission c ON c.id = r.order_commission_id
        JOIN "order" o ON o.id = c.order_id
        JOIN pos_credit_memo cm
          ON cm.order_id = c.order_id
         AND cm.deleted_at IS NULL
         AND COALESCE(cm.status, '') <> 'voided'
         AND cm.created_at > r.settled_at
       WHERE r.state = 'closed'
         AND r.deleted_at IS NULL
         AND r.settled_at > NOW() - INTERVAL '90 days'
    `);
    for (const r of clawbackRows) {
      rows.push({
        id: r.recipient_id,
        medusa_ref: `Order ${r.order_display_id ?? "?"} — ${r.display_name}`,
        qb_ref: r.cm_number ?? "",
        step: "commission_clawback_review",
        error:
          `Devolución (${r.cm_number ?? "CM"} por ${fmt(parseInt(r.cm_total ?? "0", 10))}) ` +
          `POSTERIOR a la liquidación del ${new Date(r.settled_at).toISOString().slice(0, 10)}. ` +
          `Decidir clawback contra la próxima comisión — el histórico no se toca.`,
        retries: 0,
        status: "review",
        created_at: r.cm_created_at,
      });
    }

    if (rows.length === 0) return null;
    return {
      title: "⚠️ ORDER COMMISSIONS — vigilancia",
      description:
        `Comisiones que necesitan ojos humanos: clearing desbalanceada (check sin su ` +
        `payment), liquidaciones atascadas >24h, y devoluciones posteriores a una ` +
        `comisión ya pagada (clawback manual, fuera de v1). Nada se auto-repara. ` +
        `(Definición: jobs/_lib/_commission-invariant-section.ts)`,
      admin_path: "/qb-sync",
      rows,
    };
  } catch (e) {
    logger.warn(
      `[commission-invariant-section] failed (aislado, el digest sale igual): ${(e as Error).message}`
    );
    return null;
  }
}
