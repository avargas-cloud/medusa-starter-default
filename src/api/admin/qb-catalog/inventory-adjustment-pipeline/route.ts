/**
 * src/api/admin/qb-catalog/inventory-adjustment-pipeline/route.ts
 *
 * GET /admin/qb-catalog/inventory-adjustment-pipeline
 *
 * Lists rows from qb_inventory_adjustment_pipeline (one row per
 * inventory_count × QB account combination), enriched with the parent
 * count number/memo so the admin UI can render a useful table.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/utils";

interface PipelineRowRaw {
  id: string;
  inventory_count_id: string;
  qb_account_list_id: string;
  status: string;
  qb_operation_id: string | null;
  qb_list_id: string | null;
  qb_txn_number: string | null;
  payload: {
    count_number?: string;
    count_memo?: string;
    lines?: Array<{ delta_applied?: number }>;
  } | null;
  last_error: string | null;
  retries: number;
  synced_at: string | Date | null;
  void_status: string | null;
  void_operation_id: string | null;
  void_synced_at: string | Date | null;
  void_last_error: string | null;
  void_retries: number;
  created_at: string | Date;
  updated_at: string | Date;
}

interface CountRow {
  id: string;
  number: string | null;
  memo: string | null;
}

const ALLOWED_STATUSES = new Set(["waiting", "processing", "synced", "error"]);

const ALLOWED_VOID_STATUSES = new Set([
  "waiting",
  "processing",
  "voided",
  "error",
]);

const toIso = (v: string | Date | null): string | null => {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  return v;
};

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY);

  const limitParam = Number(req.query.limit ?? 50);
  const offsetParam = Number(req.query.offset ?? 0);
  const limit = Number.isFinite(limitParam)
    ? Math.min(200, Math.max(1, limitParam))
    : 50;
  const offset = Number.isFinite(offsetParam) ? Math.max(0, offsetParam) : 0;

  const statusParam = req.query.status ? String(req.query.status) : "";
  const voidStatusParam = req.query.void_status
    ? String(req.query.void_status)
    : "";

  const filters: Record<string, unknown> = {};
  if (ALLOWED_STATUSES.has(statusParam)) filters.status = statusParam;
  if (ALLOWED_VOID_STATUSES.has(voidStatusParam))
    filters.void_status = voidStatusParam;

  const { data: rows, metadata } = await query.graph({
    entity: "qb_inventory_adjustment_pipeline",
    fields: [
      "id",
      "seq",
      "inventory_count_id",
      "qb_account_list_id",
      "status",
      "qb_operation_id",
      "qb_list_id",
      "qb_txn_number",
      "payload",
      "last_error",
      "retries",
      "synced_at",
      "void_status",
      "void_operation_id",
      "void_synced_at",
      "void_last_error",
      "void_retries",
      "created_at",
      "updated_at",
    ],
    filters,
    pagination: {
      skip: offset,
      take: limit,
      order: { created_at: "DESC" },
    },
  });

  const typed = rows as unknown as PipelineRowRaw[];
  const countIds = Array.from(new Set(typed.map((r) => r.inventory_count_id)));
  const countById = new Map<string, CountRow>();
  if (countIds.length > 0) {
    const { data: counts } = await query.graph({
      entity: "inventory_count",
      fields: ["id", "number", "memo"],
      filters: { id: countIds } as Record<string, unknown>,
      pagination: { skip: 0, take: countIds.length },
    });
    for (const c of counts as unknown as CountRow[]) countById.set(c.id, c);
  }

  const enriched = typed.map((r) => {
    const count = countById.get(r.inventory_count_id);
    const lines = Array.isArray(r.payload?.lines) ? r.payload.lines : [];
    const totalDeltaUnits = lines.reduce(
      (acc, l) => acc + Math.abs(Number(l.delta_applied ?? 0)),
      0
    );
    return {
      id: r.id,
      seq: (r as any).seq,
      status: r.status,
      void_status: r.void_status,
      count_id: r.inventory_count_id,
      count_number: count?.number ?? r.payload?.count_number ?? null,
      count_memo: count?.memo ?? r.payload?.count_memo ?? null,
      qb_account_list_id: r.qb_account_list_id,
      qb_txn_number: r.qb_txn_number,
      qb_list_id: r.qb_list_id,
      retries: r.retries ?? 0,
      void_retries: r.void_retries ?? 0,
      last_error: r.last_error,
      void_last_error: r.void_last_error,
      synced_at: toIso(r.synced_at),
      void_synced_at: toIso(r.void_synced_at),
      lines_count: lines.length,
      total_delta_units: totalDeltaUnits,
      created_at: toIso(r.created_at) ?? "",
      updated_at: toIso(r.updated_at) ?? "",
    };
  });

  return res.json({
    rows: enriched,
    count: metadata?.count ?? enriched.length,
  });
};
