import type { Pool, PoolClient } from "pg";

import type {
  LockReason,
  OrderSettlementFacts,
  ProjectApp,
  ProjectLink,
  ProjectOrderLockRow,
} from "./types";
import { PROJECT_TABLES } from "./types";

export type LockDb = Pick<Pool | PoolClient, "query">;

/** Todos los hechos de una orden en UNA consulta. `exists:false` si no está. */
export async function loadOrderSettlementFacts(
  db: LockDb,
  orderId: string
): Promise<OrderSettlementFacts> {
  const res = await db.query<{
    id: string;
    is_draft_order: boolean | null;
    deleted_at: Date | null;
    projection_received_cents: string | number | null;
    captured_dollars: string | number | null;
    fulfilled_units: string | number | null;
  }>(
    `SELECT
       o.id,
       o.is_draft_order,
       o.deleted_at,
       (SELECT omp.received_cents FROM order_money_projection omp
         WHERE omp.order_id = o.id) AS projection_received_cents,
       COALESCE((SELECT SUM(pc.captured_amount - COALESCE(pc.refunded_amount, 0))
                   FROM order_payment_collection opc
                   JOIN payment_collection pc
                     ON pc.id = opc.payment_collection_id
                    AND pc.deleted_at IS NULL
                  WHERE opc.order_id = o.id
                    AND opc.deleted_at IS NULL), 0) AS captured_dollars,
       COALESCE((SELECT SUM(oi.fulfilled_quantity)
                   FROM order_item oi
                  WHERE oi.order_id = o.id
                    AND oi.version = o.version
                    AND oi.deleted_at IS NULL), 0) AS fulfilled_units
     FROM "order" o
     WHERE o.id = $1`,
    [orderId]
  );
  const row = res.rows[0];
  if (!row) {
    return {
      orderId,
      exists: false,
      isDraftOrder: false,
      deleted: false,
      projectionReceivedCents: 0,
      capturedCents: 0,
      fulfilledUnits: 0,
    };
  }
  return {
    orderId,
    exists: true,
    isDraftOrder: row.is_draft_order === true,
    deleted: row.deleted_at !== null,
    projectionReceivedCents: Number(row.projection_received_cents ?? 0),
    capturedCents: Math.round(Number(row.captured_dollars ?? 0) * 100),
    fulfilledUnits: Number(row.fulfilled_units ?? 0),
  };
}

/** `order.metadata` crudo, para extraer los vínculos del lado de la orden. */
export async function loadOrderMetadata(
  db: LockDb,
  orderId: string
): Promise<Record<string, unknown> | null> {
  const res = await db.query<{ metadata: Record<string, unknown> | null }>(
    `SELECT metadata FROM "order" WHERE id = $1`,
    [orderId]
  );
  return res.rows[0]?.metadata ?? null;
}

function isMissingRelation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "42P01";
}

/**
 * Vínculos del lado del PROYECTO: filas de `bl_projects` / `lld_project` cuyo
 * `estimate_id` es esta orden. Cubre los 5 proyectos BL linkeados cuya orden
 * no tiene la metadata (medido 2026-09-10). Si la tabla de una app no existe
 * en este entorno, esa app aporta cero vínculos, sin romper.
 */
export async function loadProjectSideLinks(
  db: LockDb,
  orderId: string
): Promise<ProjectLink[]> {
  const links: ProjectLink[] = [];
  for (const app of Object.keys(PROJECT_TABLES) as ProjectApp[]) {
    const table = PROJECT_TABLES[app];
    try {
      const res = await db.query<{ id: string }>(
        `SELECT id FROM ${table} WHERE estimate_id = $1`,
        [orderId]
      );
      for (const row of res.rows) links.push({ app, projectId: row.id });
    } catch (error) {
      if (!isMissingRelation(error)) throw error;
    }
  }
  return links;
}

export interface InsertLockInput {
  link: ProjectLink;
  orderId: string;
  reason: LockReason;
  createdBy: string;
  facts: OrderSettlementFacts;
}

/**
 * Inserta el candado si no existe. Un candado vigente NUNCA se reescribe
 * desde acá (ni la orden, ni la razón): la primera decisión es la que vale y
 * la que se audita. Devuelve true si insertó.
 */
export async function insertLockIfAbsent(
  db: LockDb,
  input: InsertLockInput
): Promise<boolean> {
  const res = await db.query(
    `INSERT INTO project_order_lock (app, project_id, order_id, reason, created_by, facts)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (app, project_id) DO NOTHING`,
    [
      input.link.app,
      input.link.projectId,
      input.orderId,
      input.reason,
      input.createdBy,
      JSON.stringify({
        projection_received_cents: input.facts.projectionReceivedCents,
        captured_cents: input.facts.capturedCents,
        fulfilled_units: input.facts.fulfilledUnits,
      }),
    ]
  );
  return (res.rowCount ?? 0) > 0;
}

export async function listActiveLocksForOrder(
  db: LockDb,
  orderId: string
): Promise<ProjectOrderLockRow[]> {
  const res = await db.query<ProjectOrderLockRow>(
    `SELECT app, project_id, order_id, reason, locked_at, unlocked_at, created_by
       FROM project_order_lock
      WHERE order_id = $1 AND unlocked_at IS NULL`,
    [orderId]
  );
  return res.rows;
}

/**
 * Órdenes con algún vínculo (por metadata o por `estimate_id` del proyecto)
 * que todavía no tienen candado vigente para ese proyecto. Es la lista de
 * trabajo del reconciler; la decisión la toma `evaluateProjectLocksForOrder`.
 */
export async function listOrdersWithUnlockedLinks(
  db: LockDb,
  limit: number
): Promise<string[]> {
  const safeLimit = Math.min(1000, Math.max(1, limit));
  const sources: string[] = [
    `SELECT 'backlighting'::text AS app, o.metadata->>'backlighting_project_id' AS project_id, o.id AS order_id
       FROM "order" o
      WHERE o.metadata ? 'backlighting_project_id' AND o.deleted_at IS NULL AND o.is_draft_order = false`,
    `SELECT 'linear-lighting'::text, o.metadata->>'ll_project_id', o.id
       FROM "order" o
      WHERE o.metadata ? 'll_project_id' AND o.deleted_at IS NULL AND o.is_draft_order = false`,
  ];
  for (const app of Object.keys(PROJECT_TABLES) as ProjectApp[]) {
    const table = PROJECT_TABLES[app];
    try {
      await db.query(`SELECT 1 FROM ${table} LIMIT 0`);
      sources.push(
        `SELECT '${app}'::text, p.id, p.estimate_id
           FROM ${table} p
           JOIN "order" o ON o.id = p.estimate_id AND o.deleted_at IS NULL AND o.is_draft_order = false
          WHERE p.estimate_id IS NOT NULL`
      );
    } catch (error) {
      if (!isMissingRelation(error)) throw error;
    }
  }
  const res = await db.query<{ order_id: string }>(
    `WITH links AS (${sources.join(" UNION ")})
     SELECT DISTINCT l.order_id
       FROM links l
       LEFT JOIN project_order_lock k
         ON k.app = l.app AND k.project_id = l.project_id AND k.unlocked_at IS NULL
      WHERE l.project_id IS NOT NULL AND l.project_id <> '' AND k.project_id IS NULL
      ORDER BY l.order_id
      LIMIT $1`,
    [safeLimit]
  );
  return res.rows.map((r) => r.order_id);
}
