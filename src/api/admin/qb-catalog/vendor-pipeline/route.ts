import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/utils";

const ALLOWED_STATUSES = new Set(["waiting", "synced", "error"]);

/**
 * GET /admin/qb-catalog/vendor-pipeline
 * Query: status=waiting|synced|error, search=<substring>
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY);

  const statusParam = req.query.status ? String(req.query.status) : "";
  const search = req.query.search ? String(req.query.search).toLowerCase() : "";

  const filters: Record<string, unknown> = {};
  if (ALLOWED_STATUSES.has(statusParam)) {
    filters.status = statusParam;
  }

  const { data } = await query.graph({
    entity: "qb_vendor_pipeline",
    fields: [
      "id",
      "seq",
      "vendor_id",
      "vendor_name",
      "op_type",
      "status",
      "qb_operation_id",
      "qb_list_id",
      "last_error",
      "retries",
      "resolved_at",
      "created_at",
      "updated_at",
    ],
    filters,
    pagination: { skip: 0, take: 2000 },
  });

  const filtered = search
    ? (data as any[]).filter((r) =>
        [r.vendor_name, r.qb_list_id, r.last_error]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(search)
      )
    : data;

  const counts = { waiting: 0, synced: 0, error: 0 };
  const { data: all } = await query.graph({
    entity: "qb_vendor_pipeline",
    fields: ["status"],
    pagination: { skip: 0, take: 10000 },
  });
  for (const r of all as Array<{ status: string }>) {
    if (r.status in counts) counts[r.status as keyof typeof counts]++;
  }

  const toTime = (v: unknown): number => {
    if (!v) return 0;
    if (v instanceof Date) return v.getTime();
    const d = new Date(v as string);
    return Number.isNaN(d.getTime()) ? 0 : d.getTime();
  };

  return res.json({
    rows: (filtered as any[]).sort(
      (a, b) => toTime(b.created_at) - toTime(a.created_at)
    ),
    counts,
  });
};
