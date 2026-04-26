import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/utils";

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const { variant_id } = req.query as Record<string, string>;

  if (!variant_id) {
    return res.status(400).json({ error: "variant_id is required" });
  }

  const pgConnection = req.scope.resolve(
    ContainerRegistrationKeys.PG_CONNECTION
  ) as any;

  const [invoicedResult, allocatedResult, poResult] = await Promise.all([
    pgConnection.raw(
      `
      SELECT
        i.id            AS invoice_id,
        i.invoice_number,
        i.created_at,
        i.order_id,
        ii.quantity,
        TRIM(CONCAT(c.first_name, ' ', c.last_name)) AS customer_name,
        COALESCE(c.email, '') AS customer_email
      FROM pos_invoice i
      JOIN pos_invoice_item ii ON ii.invoice_id = i.id AND ii.variant_id = ?
      LEFT JOIN customer c ON c.id = i.customer_id
      WHERE i.deleted_at IS NULL
      ORDER BY i.created_at DESC
      LIMIT 200
      `,
      [variant_id]
    ),

    pgConnection.raw(
      `
      SELECT
        o.id          AS order_id,
        o.display_id,
        o.created_at,
        ri.quantity,
        TRIM(CONCAT(c.first_name, ' ', c.last_name)) AS customer_name,
        COALESCE(c.email, o.email, '') AS customer_email
      FROM reservation_item ri
      JOIN order_line_item oli ON oli.id = ri.line_item_id AND oli.variant_id = ?
      JOIN order_item oi ON oi.item_id = oli.id
        AND oi.version = (SELECT MAX(oi2.version) FROM order_item oi2 WHERE oi2.item_id = oli.id)
      JOIN "order" o ON o.id = oi.order_id
      LEFT JOIN customer c ON c.id = o.customer_id
      WHERE ri.deleted_at IS NULL
        AND o.deleted_at IS NULL
      ORDER BY o.created_at DESC
      LIMIT 200
      `,
      [variant_id]
    ),

    pgConnection.raw(
      `
      SELECT
        po.id           AS po_id,
        po.number       AS po_number,
        po.created_at,
        po.status,
        pol.qty_ordered,
        pol.qty_received,
        po.vendor_id,
        COALESCE(po.vendor_name_snapshot, 'Unknown Vendor') AS vendor_name
      FROM purchase_order_line pol
      JOIN purchase_order po ON po.id = pol.purchase_order_id
      WHERE pol.product_variant_id = ?
        AND pol.deleted_at IS NULL
        AND po.deleted_at IS NULL
      ORDER BY po.created_at DESC
      LIMIT 200
      `,
      [variant_id]
    ),
  ]);

  return res.json({
    invoiced: invoicedResult.rows,
    allocated: allocatedResult.rows,
    purchase_orders: poResult.rows,
  });
}
