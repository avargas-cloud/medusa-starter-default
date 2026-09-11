export type ProjectApp = "backlighting" | "linear-lighting";

export type LockReason = "paid" | "fulfilled";

export interface ProjectLink {
  app: ProjectApp;
  projectId: string;
}

/** Los números con los que se decide el candado — se guardan en `facts`. */
export interface OrderSettlementFacts {
  orderId: string;
  exists: boolean;
  isDraftOrder: boolean;
  deleted: boolean;
  /** `order_money_projection.received_cents` (aplicado + depósito). 0 si no hay fila. */
  projectionReceivedCents: number;
  /** Capturado nativo de Medusa (payment_collection), en centavos. */
  capturedCents: number;
  /** Unidades entregadas de la versión vigente de la orden. */
  fulfilledUnits: number;
}

export interface ProjectOrderLockRow {
  app: ProjectApp;
  project_id: string;
  order_id: string;
  reason: LockReason;
  locked_at: Date | string;
  unlocked_at: Date | string | null;
  created_by: string;
}

/** Claves de `order.metadata` que el POS escribe al vincular (set-bl-link / set-ll-link). */
export const ORDER_METADATA_PROJECT_KEYS: Record<ProjectApp, { id: string; seq: string }> = {
  backlighting: { id: "backlighting_project_id", seq: "backlighting_seq_id" },
  "linear-lighting": { id: "ll_project_id", seq: "ll_seq_id" },
};

/** Tabla de proyectos de cada app, en esta misma Postgres. */
export const PROJECT_TABLES: Record<ProjectApp, string> = {
  backlighting: "bl_projects",
  "linear-lighting": "lld_project",
};

export function isProjectLockDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PROJECT_LOCK_DISABLED === "true";
}
