/**
 * vendor-bill-invariant-scans.ts — los DOS barridos de vendor bills que el
 * digest diario reporta por email y que los `verify-*` imprimen a mano.
 *
 * POR QUÉ EXISTE ESTE ARCHIVO
 * ---------------------------
 * Los dos invariantes ya estaban escritos —`verify-sibling-bill-dispatch.ts`
 * desde el 2026-08-31 y `verify-clearing-drift.ts` desde el 2026-08-04— y los
 * dos vivían SÓLO dentro de su script. Medido el 2026-09-03: de los 167
 * `verify-*` del backend, exactamente UNO lo corre algo automáticamente. O sea
 * que el chequeo que habría avisado de VB-1129/VB-1130 existía, era correcto, y
 * no tenía quién lo mirara: $965,68 fuera del A/P de QuickBooks durante tres
 * días, descubiertos porque un operador apretó Confirm y se comió un 422.
 *
 * La comparación vive UNA vez y la comparten el script y el digest. Cuando en
 * este repo fueron dos copias (el barrido del índice de órdenes) ya habían
 * divergido en tres campos, así que el barrido y el reporte no coincidían en
 * qué era deriva. El script queda como IMPRESOR; la verdad está acá.
 *
 * Read-only, los dos. Ninguno encola nada: la base sola no distingue "nunca se
 * mandó a QuickBooks" de "alguien lo hizo a mano por fuera del pipeline" —
 * mismo criterio que `qb-void-reconciler` y `qb-drift-detector`.
 */

import {
  decideSecondaryDispatch,
  loadSecondaryDispatchFacts,
} from "./qb-vendor-bill-sibling-dispatch";
import { deriveClearingDrift } from "./qb-vendor-bill-clearing-lines";
import { loadClearingSiblings } from "./load-clearing-siblings";
import { PURCHASE_SQL } from "../quickbooks/pipeline-status";

export interface ScanKnex {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows: unknown[]; rowCount?: number }>;
}

// ── 1 · Bills secundarios PERDIDOS ───────────────────────────────────────────

export interface SiblingBillFinding {
  vendor_bill_id: string;
  number: string | null;
  bill_type: string;
  total_cents: number;
  reason: string;
}

export interface SiblingDispatchScan {
  /** Par COMPLETO y sin documento en QuickBooks. Esto es plata faltante. */
  lost: SiblingBillFinding[];
  /** Esperando a su regular. Estado SANO — nunca se reporta como alarma. */
  waiting: SiblingBillFinding[];
  lost_cents: number;
}

/**
 * Bills service/freight/tariff confirmados, sin TxnID y sin fila viva de
 * pipeline, partidos en PERDIDOS vs ESPERANDO por la misma función que decide
 * el despacho.
 *
 * La distinción es el punto entero: "confirmado sin TxnID" son 18 bills y la
 * mayoría está bien. Un chequeo que no sabe separar "esperando" de "perdido" es
 * exactamente la ceguera que dejó correr esto un mes — la pantalla decía
 * `confirmed` en los dos casos, y un verificador ingenuo también.
 *
 * Llama a `decideSecondaryDispatch` en vez de repetir la regla: un verificador
 * con su propia copia sólo puede alejarse del código que verifica.
 */
export async function scanLostSiblingBills(
  knex: ScanKnex
): Promise<SiblingDispatchScan> {
  const result = await knex.raw(
    `SELECT vb.id, vb.number, vb.bill_type,
            COALESCE((SELECT SUM(l.qty * l.unit_cost_cents)::bigint
                        FROM vendor_bill_line l
                       WHERE l.vendor_bill_id = vb.id
                         AND l.deleted_at IS NULL), 0) AS total_cents,
            EXISTS (SELECT 1 FROM qb_vendor_bill_pipeline p
                     WHERE p.vendor_bill_id = vb.id
                       AND p.deleted_at IS NULL
                       AND p.status NOT IN (${PURCHASE_SQL.failedAny})) AS has_live_row
       FROM vendor_bill vb
      WHERE vb.deleted_at IS NULL
        AND vb.bill_type <> 'regular'
        AND vb.status = 'confirmed' -- entity-status
        AND vb.qb_txn_id IS NULL
      ORDER BY vb.number`,
    []
  );

  const lost: SiblingBillFinding[] = [];
  const waiting: SiblingBillFinding[] = [];
  let lostCents = 0;

  for (const row of result.rows as Array<{
    id: string;
    number: string | null;
    bill_type: string;
    total_cents: string | number;
    has_live_row: boolean;
  }>) {
    // Ya encolado: no hay nada que decir. Un Add en vuelo no es una pérdida.
    if (row.has_live_row) continue;
    const facts = await loadSecondaryDispatchFacts(knex, row.id);
    if (!facts) continue;
    const decision = decideSecondaryDispatch(facts);
    const finding: SiblingBillFinding = {
      vendor_bill_id: row.id,
      number: row.number,
      bill_type: row.bill_type,
      total_cents: Number(row.total_cents),
      reason: decision.reason,
    };
    if (decision.dispatch) {
      lost.push(finding);
      lostCents += finding.total_cents;
    } else if (decision.deferred) {
      waiting.push(finding);
    }
  }

  return { lost, waiting, lost_cents: lostCents };
}

// ── 1b · Hermanos de agente que salieron ANTES que su regular ────────────────

export interface PrematureSiblingFinding {
  vendor_bill_id: string;
  number: string | null;
  bill_type: string;
  total_cents: number;
  qb_txn_id: string;
  /** El regular que lo apunta, o null si ninguno lo apunta todavía. */
  regular_number: string | null;
  regular_status: string | null;
}

export interface PrematureSiblingScan {
  /** En QuickBooks con su regular sin confirmar — un cargo sin contrapartida. */
  premature: PrematureSiblingFinding[];
  /** Los mismos, pero decididos a propósito por el dueño: no son alarma. */
  accepted: PrematureSiblingFinding[];
  premature_cents: number;
}

/**
 * Hermanos que el dueño decidió DEJAR en QuickBooks (2026-09-15) después de
 * que la regla del 08-31 los mandara solos. Sus regulares (VB-1234, VB-1237)
 * los saltan al confirmar y posteán igual la clearing line que los cancela —
 * verificado en prod con VB-1150/1153, que recorrieron ese mismo camino.
 *
 * Por NÚMERO y no por fecha: una allowlist "todo lo anterior a X" absorbe
 * también el próximo caso que ocurra el día X.
 */
export const PREMATURE_SIBLINGS_ACCEPTED_BY_OWNER: ReadonlySet<string> = new Set([
  "VB-1235",
  "VB-1236",
  "VB-1239",
  "VB-1240",
]);

/**
 * Bills service/freight/tariff de un vendor AGENTE que tienen TxnID mientras el
 * regular que los apunta no está confirmado/synced — o ninguno los apunta.
 *
 * Es la falla INVERSA de `scanLostSiblingBills`: allá el par está completo y
 * falta el documento; acá el documento existe y el par no. Vivió 11 días
 * (09/04→09/15) sin que nada se pusiera rojo porque el otro barrido, por
 * construcción, sólo mira bills SIN TxnID.
 *
 * Un regular en `draft` CON TxnID (revisión) no cuenta: su Bill sigue en
 * QuickBooks restando al hermano — es el caso VB-1128 del 09-03.
 */
export async function scanPrematureSiblingDispatch(
  knex: ScanKnex
): Promise<PrematureSiblingScan> {
  const result = await knex.raw(
    `SELECT vb.id, vb.number, vb.bill_type, vb.qb_txn_id,
            COALESCE((SELECT SUM(l.qty * l.unit_cost_cents)::bigint
                        FROM vendor_bill_line l
                       WHERE l.vendor_bill_id = vb.id
                         AND l.deleted_at IS NULL), 0) AS total_cents,
            reg.number AS regular_number,
            reg.status AS regular_status,
            (reg.qb_txn_id IS NOT NULL) AS regular_in_qb
       FROM vendor_bill vb
       JOIN qb_vendor v ON v.id = vb.vendor_id
       LEFT JOIN LATERAL (
         SELECT r.number, r.status, r.qb_txn_id
           FROM vendor_bill r
          WHERE r.deleted_at IS NULL AND r.bill_type = 'regular'
            AND vb.id IN (r.service_vendor_bill_id, r.freight_vendor_bill_id,
                          r.tariff_vendor_bill_id)
          ORDER BY r.created_at DESC
          LIMIT 1
       ) reg ON true
      WHERE vb.deleted_at IS NULL
        AND vb.bill_type IN ('service', 'freight', 'tariff')
        AND vb.qb_txn_id IS NOT NULL
        AND vb.status <> 'voided' -- entity-status
        AND (v.metadata @> '{"is_china_agent": true}'::jsonb
             OR lower(v.metadata->>'is_china_agent') = 'true')
        AND (reg.number IS NULL
             OR (reg.status NOT IN ('confirmed', 'synced') AND reg.qb_txn_id IS NULL)) -- entity-status
      ORDER BY vb.number`,
    []
  );

  const premature: PrematureSiblingFinding[] = [];
  const accepted: PrematureSiblingFinding[] = [];
  let prematureCents = 0;

  for (const row of result.rows as Array<{
    id: string;
    number: string | null;
    bill_type: string;
    qb_txn_id: string;
    total_cents: string | number;
    regular_number: string | null;
    regular_status: string | null;
  }>) {
    const finding: PrematureSiblingFinding = {
      vendor_bill_id: row.id,
      number: row.number,
      bill_type: row.bill_type,
      total_cents: Number(row.total_cents),
      qb_txn_id: row.qb_txn_id,
      regular_number: row.regular_number,
      regular_status: row.regular_status,
    };
    if (row.number && PREMATURE_SIBLINGS_ACCEPTED_BY_OWNER.has(row.number)) {
      accepted.push(finding);
    } else {
      premature.push(finding);
      prematureCents += finding.total_cents;
    }
  }

  return { premature, accepted, premature_cents: prematureCents };
}

// ── 2 · Clearing lines desactualizadas ───────────────────────────────────────

export interface ClearingDriftFinding {
  vendor_bill_id: string;
  number: string | null;
  /** Positivo = QuickBooks cancela DE MENOS; negativo = cancela de más. */
  delta_cents: number;
  items: Array<{
    kind: string;
    sibling_number: string | null;
    quickbooks_cents: number;
    current_cents: number;
  }>;
}

/**
 * Bills regulares que VIVEN en QuickBooks y cuyas clearing lines persistidas ya
 * no coinciden con lo que valen sus hermanos hoy.
 *
 * Sólo los que están en QuickBooks: un regular que todavía no posteó no tiene
 * A/P descuadrado que reportar, y su columna se va a escribir recién con el
 * Add. Ésa es la misma condición que usa el aviso de la pantalla del bill.
 */
export async function scanClearingDrift(
  knex: ScanKnex
): Promise<ClearingDriftFinding[]> {
  const result = await knex.raw(
    `SELECT vb.id, vb.number,
            COALESCE(vb.qb_clearing_lines, '[]'::jsonb) AS persisted
       FROM vendor_bill vb
      WHERE vb.bill_type = 'regular'
        AND vb.deleted_at IS NULL
        AND vb.qb_txn_id IS NOT NULL
        AND (vb.service_vendor_bill_id IS NOT NULL
             OR vb.freight_vendor_bill_id IS NOT NULL
             OR vb.tariff_vendor_bill_id IS NOT NULL)
      ORDER BY vb.number`,
    []
  );

  const findings: ClearingDriftFinding[] = [];
  for (const row of result.rows as Array<{
    id: string;
    number: string | null;
    persisted: unknown;
  }>) {
    const siblings = await loadClearingSiblings(knex, row.id);
    const drift = deriveClearingDrift(
      (row.persisted ?? []) as never,
      siblings
    );
    if (!drift.stale) continue;
    findings.push({
      vendor_bill_id: row.id,
      number: row.number,
      delta_cents: drift.delta_cents,
      items: drift.items.map((i) => ({
        kind: i.kind,
        sibling_number: i.number,
        quickbooks_cents: i.quickbooks_cents,
        current_cents: i.current_cents,
      })),
    });
  }
  return findings;
}
