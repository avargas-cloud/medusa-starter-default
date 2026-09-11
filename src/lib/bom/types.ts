export type BomApp = "backlighting" | "linear-lighting";

export interface BomLineInput {
  sku: string;
  quantity: number;
}

export interface NormalizedBomLine {
  sku: string;
  quantity: number;
  /** Identidad estable de la línea dentro del carrito: app + proyecto + SKU. */
  sourceKey: string;
}

export interface SyncCartBomInput {
  cartId: string;
  /** actor_id del cliente autenticado — nunca el customer_id que diga el body. */
  customerId: string;
  app: BomApp;
  projectId: string;
  projectSeq?: string | null;
  lines: BomLineInput[];
}

export type UnresolvedReason = "not_found" | "unavailable";

export interface UnresolvedBomLine {
  sku: string;
  quantity: number;
  reason: UnresolvedReason;
  message?: string;
}

export interface SyncCartBomResult {
  cart_id: string;
  app: BomApp;
  project_id: string;
  /** Líneas del proyecto que quedaron en el carrito después del sync. */
  added: number;
  /** Líneas del proyecto que había y se reemplazaron. */
  removed: number;
  unresolved: UnresolvedBomLine[];
  metadata: Record<string, unknown>;
}

export class SyncCartBomError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "SyncCartBomError";
  }
}

/** Claves de provenance por línea — las MISMAS que escribe el POS (sync-pos, add-item-force). */
export const LINE_PROVENANCE_KEYS = {
  app: "source_app",
  projectId: "source_project_id",
  key: "source_key",
} as const;

/** Claves de `cart.metadata` que heredará la orden — las MISMAS que set-bl-link / set-ll-link. */
export const CART_LINK_KEYS: Record<BomApp, { id: string; seq: string; linkedAt: string; linkedBy: string }> = {
  backlighting: {
    id: "backlighting_project_id",
    seq: "backlighting_seq_id",
    linkedAt: "backlighting_linked_at",
    linkedBy: "backlighting_linked_by",
  },
  "linear-lighting": {
    id: "ll_project_id",
    seq: "ll_seq_id",
    linkedAt: "ll_linked_at",
    linkedBy: "ll_linked_by",
  },
};

export const MAX_BOM_LINES = 200;
