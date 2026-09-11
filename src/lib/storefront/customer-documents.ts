import type { MedusaContainer } from "@medusajs/framework/types";

import type {
  CustomerInvoiceAddress,
  CustomerInvoice,
  CustomerInvoiceItem,
  CustomerInvoiceTracking,
  CustomerShipment,
} from "./customer-documents-types";

export type {
  CustomerInvoice,
  CustomerInvoiceItem,
  CustomerInvoiceTracking,
  CustomerShipment,
  CustomerShipmentLine,
} from "./customer-documents-types";

/**
 * src/lib/storefront/customer-documents.ts
 *
 * Customer-scoped read model for invoices + shipments, powering
 * /store/customers/me/{invoices,shipments}. Every query is bound by
 * customer ownership — either `pos_invoice.customer_id` (set at issue time)
 * or the parent `order.customer_id`, since some legacy invoices predate the
 * column being backfilled consistently (see project_pos_product_metadata_split_brain
 * for the general split-brain shape of this problem).
 *
 * Money columns on pos_invoice / pos_invoice_item are CENTS (CLAUDE.md rule
 * 2026-08-07). Every money field returned here is coerced to DOLLARS with 2
 * decimals as a number — never cents, never a raw DB value (which may arrive
 * as a numeric string).
 *
 * Output is a strict allowlist projection: callers must not spread a raw row.
 * Forbidden fields (internal/PII/cost — never leave this module):
 * average_unit_cost, average_unit_cost_synced_at, net_total_cents, created_by,
 * notes, metadata, amount_paid, balance_due, payment_method, card_brand,
 * provider_object_id, label_url, rate_amount_cents, assigned_by_user_id,
 * created_by_user_id, idempotency_key, void_reason.
 */

type PgConnection = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: any[] }>;
};

function resolvePg(container: MedusaContainer): PgConnection {
  return container.resolve("__pg_connection__") as PgConnection;
}

/** DB numeric/string cents -> dollars, rounded to 2 decimals, as a number. */
function centsToDollarsNum(value: unknown): number {
  const cents = Number(value ?? 0);
  return Math.round(cents) / 100;
}

function projectInvoiceRow(row: any): Omit<CustomerInvoice, "items" | "tracking"> {
  return {
    id: row.id,
    invoice_number: row.invoice_number,
    order_id: row.order_id,
    order_display_id: row.order_display_id ?? null,
    status: row.status,
    issued_at: row.issued_at ?? null,
    subtotal: centsToDollarsNum(row.subtotal),
    discount: centsToDollarsNum(row.discount),
    shipping: centsToDollarsNum(row.shipping),
    tax: centsToDollarsNum(row.tax),
    total: centsToDollarsNum(row.total),
    refunded_amount: centsToDollarsNum(row.refunded_amount),
    shipping_address: projectAddress(row.shipping_address),
  };
}

/** Address snapshot → only what a customer needs to see (drops id, customer_id, metadata, timestamps). */
function projectAddress(a: any): CustomerInvoiceAddress | null {
  if (!a || typeof a !== "object") return null;
  return {
    first_name: a.first_name ?? null,
    last_name: a.last_name ?? null,
    company: a.company ?? null,
    address_1: a.address_1 ?? null,
    address_2: a.address_2 ?? null,
    city: a.city ?? null,
    province: a.province ?? null,
    postal_code: a.postal_code ?? null,
    country_code: a.country_code ?? null,
    phone: a.phone ?? null,
  };
}

function projectItemRow(row: any): CustomerInvoiceItem {
  return {
    sku: row.sku ?? null,
    description: row.description,
    quantity: Number(row.quantity),
    refunded_quantity: Number(row.refunded_quantity ?? 0),
    unit_price: centsToDollarsNum(row.unit_price),
    total: centsToDollarsNum(row.total),
    order_line_item_id: row.order_line_item_id ?? null,
  };
}

function projectTrackingRow(row: any): CustomerInvoiceTracking {
  return {
    carrier: row.carrier ?? null,
    tracking_number: row.tracking_number,
    tracking_url: row.tracking_url ?? null,
    shipped_at: row.shipped_at ?? null,
  };
}

async function hydrateInvoices(
  pg: PgConnection,
  invoiceRows: any[]
): Promise<CustomerInvoice[]> {
  if (invoiceRows.length === 0) return [];
  const ids = invoiceRows.map((r) => r.id);

  const [itemsResult, trackingResult] = await Promise.all([
    pg.raw(
      `SELECT invoice_id, sku, description, quantity, refunded_quantity,
              unit_price, total, order_line_item_id
         FROM pos_invoice_item
        WHERE invoice_id = ANY(?::text[])
          AND deleted_at IS NULL
        ORDER BY invoice_id, sort_order NULLS LAST, id`,
      [ids]
    ),
    pg.raw(
      `SELECT invoice_id, carrier, tracking_number, tracking_url, shipped_at
         FROM invoice_tracking
        WHERE invoice_id = ANY(?::text[])
          AND deleted_at IS NULL
        ORDER BY invoice_id, created_at`,
      [ids]
    ),
  ]);

  const itemsByInvoice = new Map<string, CustomerInvoiceItem[]>();
  for (const row of itemsResult.rows) {
    const list = itemsByInvoice.get(row.invoice_id) ?? [];
    list.push(projectItemRow(row));
    itemsByInvoice.set(row.invoice_id, list);
  }

  const trackingByInvoice = new Map<string, CustomerInvoiceTracking[]>();
  for (const row of trackingResult.rows) {
    const list = trackingByInvoice.get(row.invoice_id) ?? [];
    list.push(projectTrackingRow(row));
    trackingByInvoice.set(row.invoice_id, list);
  }

  return invoiceRows.map((row) => ({
    ...projectInvoiceRow(row),
    items: itemsByInvoice.get(row.id) ?? [],
    tracking: trackingByInvoice.get(row.id) ?? [],
  }));
}

/**
 * List a customer's issued invoices (drafts never leave this module — a
 * draft is an in-progress POS document, not a customer-facing receipt).
 * Ownership: `pos_invoice.customer_id` OR the parent order's `customer_id`,
 * matching whichever the row actually carries.
 */
export async function listCustomerInvoices(
  container: MedusaContainer,
  customerId: string,
  options: { orderId?: string; limit?: number; offset?: number } = {}
): Promise<{ invoices: CustomerInvoice[]; count: number }> {
  const pg = resolvePg(container);
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
  const offset = Math.max(options.offset ?? 0, 0);

  const whereOrderId = options.orderId ? "AND i.order_id = ?" : "";
  const baseBindings: unknown[] = [customerId, customerId];
  if (options.orderId) baseBindings.push(options.orderId);

  const countResult = await pg.raw(
    `SELECT COUNT(*)::int AS count
       FROM pos_invoice i
       JOIN "order" o ON o.id = i.order_id
      WHERE (i.customer_id = ? OR o.customer_id = ?)
        AND i.deleted_at IS NULL
        AND i.status NOT IN ('draft', 'voided')
        ${whereOrderId}`,
    baseBindings
  );
  const count = Number(countResult.rows[0]?.count ?? 0);

  const listResult = await pg.raw(
    `SELECT i.id, i.invoice_number, i.order_id, o.display_id AS order_display_id,
            i.status, i.issued_at, i.subtotal, i.discount, i.shipping, i.tax,
            i.total, i.refunded_amount, i.shipping_address, i.created_at
       FROM pos_invoice i
       JOIN "order" o ON o.id = i.order_id
      WHERE (i.customer_id = ? OR o.customer_id = ?)
        AND i.deleted_at IS NULL
        AND i.status NOT IN ('draft', 'voided')
        ${whereOrderId}
      ORDER BY i.issued_at DESC NULLS LAST, i.created_at DESC
      LIMIT ? OFFSET ?`,
    [...baseBindings, limit, offset]
  );

  const invoices = await hydrateInvoices(pg, listResult.rows);
  return { invoices, count };
}

/**
 * A single invoice, scoped to the requesting customer. Returns `null` when
 * the invoice doesn't exist, is a draft, or isn't owned by `customerId` —
 * callers turn `null` into a 404, never a 403 (don't confirm existence).
 */
export async function getCustomerInvoice(
  container: MedusaContainer,
  customerId: string,
  invoiceId: string
): Promise<CustomerInvoice | null> {
  const pg = resolvePg(container);

  const result = await pg.raw(
    `SELECT i.id, i.invoice_number, i.order_id, o.display_id AS order_display_id,
            i.status, i.issued_at, i.subtotal, i.discount, i.shipping, i.tax,
            i.total, i.refunded_amount, i.shipping_address
       FROM pos_invoice i
       JOIN "order" o ON o.id = i.order_id
      WHERE i.id = ?
        AND (i.customer_id = ? OR o.customer_id = ?)
        AND i.deleted_at IS NULL
        AND i.status NOT IN ('draft', 'voided')
      LIMIT 1`,
    [invoiceId, customerId, customerId]
  );

  const row = result.rows[0];
  if (!row) return null;

  const [invoice] = await hydrateInvoices(pg, [row]);
  return invoice ?? null;
}

/**
 * List a customer's shipments (order_delivery rows), newest first.
 * Ownership: the parent order's `customer_id` — order_delivery carries no
 * customer_id of its own.
 */
export async function listCustomerShipments(
  container: MedusaContainer,
  customerId: string,
  options: { orderId?: string } = {}
): Promise<{ shipments: CustomerShipment[] }> {
  const pg = resolvePg(container);

  const whereOrderId = options.orderId ? "AND d.order_id = ?" : "";
  const bindings: unknown[] = [customerId];
  if (options.orderId) bindings.push(options.orderId);

  const result = await pg.raw(
    `SELECT d.id, d.order_id, o.display_id AS order_display_id, d.invoice_id,
            inv.invoice_number, d.invoice_scope, d.carrier, d.tracking_number,
            d.tracking_url, d.service, d.status, d.status_detail, d.shipped_at,
            d.delivered_at,
            (SELECT COALESCE(json_agg(json_build_object(
                      'order_line_item_id', odl.order_line_item_id,
                      'quantity', odl.quantity,
                      'sku', oli.variant_sku,
                      'title', oli.title
                    ) ORDER BY odl.id), '[]'::json)
               FROM order_delivery_line odl
               LEFT JOIN order_line_item oli ON oli.id = odl.order_line_item_id
              WHERE odl.delivery_id = d.id AND odl.deleted_at IS NULL) AS lines
       FROM order_delivery d
       JOIN "order" o ON o.id = d.order_id
       LEFT JOIN pos_invoice inv ON inv.id = d.invoice_id AND inv.deleted_at IS NULL
      WHERE o.customer_id = ?
        AND d.deleted_at IS NULL
        AND d.voided_at IS NULL
        ${whereOrderId}
      ORDER BY d.created_at DESC`,
    bindings
  );

  const shipments: CustomerShipment[] = result.rows.map((row) => ({
    id: row.id,
    order_id: row.order_id,
    order_display_id: row.order_display_id ?? null,
    invoice_id: row.invoice_id ?? null,
    invoice_number: row.invoice_number ?? null,
    invoice_scope: row.invoice_scope ?? null,
    carrier: row.carrier ?? null,
    tracking_number: row.tracking_number ?? null,
    tracking_url: row.tracking_url ?? null,
    service: row.service ?? null,
    status: row.status,
    status_detail: row.status_detail ?? null,
    shipped_at: row.shipped_at ?? null,
    delivered_at: row.delivered_at ?? null,
    lines: (row.lines ?? []).map((l: any) => ({
      order_line_item_id: l.order_line_item_id,
      quantity: Number(l.quantity),
      sku: l.sku ?? null,
      title: l.title ?? null,
    })),
  }));

  return { shipments };
}
