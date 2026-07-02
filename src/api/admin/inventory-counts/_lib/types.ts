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
  qty_counted: number | null;
  qty_counted_available: number | null;
  qty_counted_reserved: number | null;
  reserved_at_count_time: number | null;
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
}
