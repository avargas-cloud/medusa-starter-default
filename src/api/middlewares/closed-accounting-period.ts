import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

type ResourceType =
  | "order"
  | "invoice"
  | "credit_memo"
  | "purchase_order"
  | "vendor_bill"
  | "inventory_count";

const RESOURCE_DATE_SQL: Record<ResourceType, string> = {
  order: `SELECT COALESCE(o.created_at, NOW()) AS economic_at
            FROM "order" o WHERE o.id = ? AND o.deleted_at IS NULL`,
  invoice: `SELECT COALESCE(i.issued_at, i.created_at) AS economic_at
              FROM pos_invoice i WHERE i.id = ? AND i.deleted_at IS NULL`,
  credit_memo: `SELECT COALESCE(cm.completed_at, cm.created_at) AS economic_at
                  FROM pos_credit_memo cm WHERE cm.id = ? AND cm.deleted_at IS NULL`,
  purchase_order: `SELECT COALESCE(po.ordered_at, po.created_at) AS economic_at
                     FROM purchase_order po WHERE po.id = ? AND po.deleted_at IS NULL`,
  vendor_bill: `SELECT COALESCE(vb.document_date, vb.created_at) AS economic_at
                  FROM vendor_bill vb WHERE vb.id = ? AND vb.deleted_at IS NULL`,
  inventory_count: `SELECT COALESCE(ic.applied_at, ic.submitted_at, ic.created_at) AS economic_at
                      FROM inventory_count ic WHERE ic.id = ? AND ic.deleted_at IS NULL`,
};

const RESOURCE_LABEL: Record<ResourceType, string> = {
  order: "Order",
  invoice: "Invoice",
  credit_memo: "Credit memo",
  purchase_order: "Purchase order",
  vendor_bill: "Vendor bill",
  inventory_count: "Inventory adjustment",
};

function pathAllowed(resource: ResourceType, path: string): boolean {
  if (resource === "order") {
    return /\/toggle-close(\/|$)/.test(path);
  }
  if (resource === "invoice") {
    return /\/(payments|applied-payments)(\/|$)/.test(path);
  }
  if (resource === "purchase_order") {
    return (
      /\/receive(\/|$)/.test(path) ||
      /\/receipts(\/|$)/.test(path) ||
      /\/vendor-bill(\/|$)/.test(path)
    );
  }
  if (resource === "vendor_bill") {
    return /\/(check-payment|cost-replay-preview)(\/|$)/.test(path);
  }
  return false;
}

async function activeCloseForDate(
  req: MedusaRequest,
  economicAt: unknown
): Promise<Record<string, unknown> | null> {
  const db = req.scope.resolve("__pg_connection__") as {
    raw: (
      sql: string,
      bindings?: unknown[]
    ) => Promise<{ rows: Array<Record<string, unknown>> }>;
  };
  const result = await db.raw(
    `SELECT id, period_start, period_end, revision
       FROM accounting_period_close
      WHERE status = 'closed'
        AND ?::timestamptz >= period_start::timestamptz
        AND ?::timestamptz < period_end::timestamptz
      ORDER BY revision DESC
      LIMIT 1`,
    [economicAt, economicAt]
  );
  return result.rows[0] ?? null;
}

export function protectClosedDocument(resource: ResourceType) {
  return async (
    req: MedusaRequest,
    res: MedusaResponse,
    next: MedusaNextFunction
  ) => {
    if (pathAllowed(resource, req.path)) return next();
    const id = req.params.id;
    if (!id) return next();

    const db = req.scope.resolve("__pg_connection__") as {
      raw: (
        sql: string,
        bindings?: unknown[]
      ) => Promise<{ rows: Array<Record<string, unknown>> }>;
    };
    const resourceResult = await db.raw(RESOURCE_DATE_SQL[resource], [id]);
    const economicAt = resourceResult.rows[0]?.economic_at;
    if (!economicAt) return next();

    const close = await activeCloseForDate(req, economicAt);
    if (!close) return next();
    return res.status(423).json({
      error:
        `${RESOURCE_LABEL[resource]} belongs to a closed accounting month and cannot be edited. ` +
        "Reopen the month from Accounting → Month Close to make a correction.",
      code: "accounting_period_closed",
      resource_type: resource,
      resource_id: id,
      period_start: close.period_start,
      period_end: close.period_end,
      revision: close.revision,
    });
  };
}

export async function rejectClosedEffectiveDate(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const candidate =
    body.issued_at ??
    body.document_date ??
    body.ordered_at ??
    body.applied_at ??
    body.paid_at ??
    body.received_at;
  if (!candidate) return next();

  const date = new Date(String(candidate));
  if (Number.isNaN(date.getTime())) return next();
  const close = await activeCloseForDate(req, date.toISOString());
  if (!close) return next();
  return res.status(423).json({
    error: "New events cannot be backdated into a closed accounting month.",
    code: "accounting_period_closed_for_date",
    period_start: close.period_start,
    period_end: close.period_end,
    revision: close.revision,
  });
}
