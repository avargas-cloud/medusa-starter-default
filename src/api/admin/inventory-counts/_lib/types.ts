/**
 * src/api/admin/inventory-counts/_lib/types.ts
 *
 * Wire-format DTOs for the /admin/inventory-counts/* endpoints.
 * Kept separate from the module's persistence shapes so we can evolve the
 * API surface without coupling it to the DB layout.
 */

import type {
  InventoryCountLineStatus,
  InventoryCountStatus,
  InventoryCountLineBlockReason,
  ApprovalLineAction,
} from "../../../../modules/inventory-count/types";

export interface InventoryCountDto {
  id: string;
  number: string;
  year: number;
  seq: number;
  status: InventoryCountStatus;
  stock_location_id: string;
  category_filter_id: string | null;
  sku_prefix_filter: string | null;
  memo: string | null;
  default_qb_account_list_id: string;
  created_by_user_id: string;
  submitted_at: string | null;
  reviewed_by_user_id: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  applied_at: string | null;
  qb_synced_at: string | null;
  total_lines: number;
  total_lines_applied: number;
  total_lines_blocked: number;
  total_delta_units: number;
  created_at: string;
  updated_at: string;
}

export interface InventoryCountLineDto {
  id: string;
  inventory_count_id: string;
  product_variant_id: string;
  inventory_item_id: string;
  sku: string;
  product_title: string;
  /** Live QB sales description (variant metadata) — display-only enrichment. */
  product_sales_description?: string | null;
  qty_counted: number | null;
  qty_counted_available: number | null;
  qty_counted_reserved: number | null;
  reserved_at_count_time: number | null;
  effective_reserved_at_count_time: number | null;
  qty_at_count_time: number | null;
  delta_original: number | null;
  delta_applied: number | null;
  qty_at_apply_time: number | null;
  projected_stock: number | null;
  status: InventoryCountLineStatus;
  block_reason: InventoryCountLineBlockReason | null;
  override_note: string | null;
  resulted_negative: boolean;
  counted_at: string | null;
  stocked_at_count: number | null;
  needs_recount: boolean;
  stock_moved_at: string | null;
  stocked_after_movement: number | null;
  qb_account_list_id: string | null;
  qb_line_index: number | null;
  qb_synced_at: string | null;
  qb_last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateDraftBody {
  stock_location_id: string;
  category_filter_id?: string | null;
  sku_prefix_filter?: string | null;
  default_qb_account_list_id?: string;
}

export interface UpdateDraftLineInput {
  product_variant_id: string;
  inventory_item_id: string;
  sku: string;
  product_title: string;
  // Components; qty_counted (total) is derived server-side = on_hand + reserved.
  // on_hand === null means the line is still uncounted (dropped at submit).
  qty_counted_available: number | null;
  qty_counted_reserved: number | null;
  qb_account_list_id?: string | null;
}

export interface UpdateDraftBody {
  lines?: UpdateDraftLineInput[];
  memo?: string;
}

export interface SubmitBody {
  memo: string;
}

export interface ApprovalDecision {
  line_id: string;
  action: ApprovalLineAction;
  override_delta?: number;
  override_note?: string;
  qb_account_list_id?: string;
}

export interface ApproveBody {
  decisions: ApprovalDecision[];
}

export interface RejectBody {
  review_notes: string;
}

export interface PreviewApprovalLine {
  line_id: string;
  sku: string;
  product_title: string;
  /** Live QB sales description (variant metadata) — display-only enrichment. */
  product_sales_description?: string | null;
  qty_at_count_time: number;
  qty_counted: number;
  delta_original: number;
  current_stock_now: number;
  projected_stock: number;
  // Informational only — applying delta_original would drive on-hand below 0.
  // Allowed (not blocked); surfaced so the manager is aware before approving.
  will_go_negative: boolean;
  block_reason: InventoryCountLineBlockReason | null;
  qb_account_list_id: string;
  unit_cost: number | null;
  /**
   * Número del count que ya tiene tomado este ítem, o null si está libre.
   *
   * El approve va a rechazar la operación entera si alguno viene con valor, así
   * que el manager tiene que verlo ANTES de apretar — y decidir override 0 en
   * esa línea en vez de comerse un 409 sobre las 40 restantes.
   */
  claimed_by_count_number: string | null;
  claimed_by_count_id: string | null;
}

/**
 * Una línea que ya se resolvió en una pasada anterior (`applied`, `overridden`,
 * `verified`, `skipped`). Se devuelve SÓLO como contexto de lectura.
 *
 * Existe porque el preview cargaba todas las líneas del count mientras el
 * approve carga únicamente `pending`/`blocked`: en un `partially_applied` eso
 * re-mostraba el trabajo de la pasada anterior como si estuviera por aplicarse,
 * y el COST IMPACT sumaba plata que ya se había contabilizado (INVCNT-1047
 * mostraba −$574.49 cuando el impacto real era $0.00).
 */
export interface PreviewResolvedLine {
  line_id: string;
  sku: string;
  product_title: string;
  status: string;
  delta_original: number;
  delta_applied: number | null;
  qty_at_apply_time: number | null;
  override_note: string | null;
}
