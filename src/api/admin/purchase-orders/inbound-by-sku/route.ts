/**
 * GET /admin/purchase-orders/inbound-by-sku?sku=XXX
 *
 * The decomposition of `/on-order`: not just how many units of a SKU are still
 * coming, but on which deliveries, with which carrier number, arriving when.
 *
 * Powers the POS stock modal on a line item. A cashier mid-sale needs to answer
 * "when do the other 30 land?" without leaving the document to go hunt for the
 * PO in the purchasing section.
 *
 * READ-ONLY. Nothing here writes, enqueues or touches QuickBooks.
 *
 * THE HEADLINE NUMBER IS THE SAME NUMBER. `on_order` in this response is
 * computed from the SAME status constants `/on-order` uses (`_lib/po-active-status`),
 * so the two endpoints cannot drift into disagreeing about one SKU — which would
 * show up as a modal whose total contradicts its own rows.
 * `verify-inbound-by-sku.ts` asserts that equality against live data.
 *
 * Response: InboundBySku (see lib/purchase-orders/inbound-by-sku.ts)
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { resolveInboundBySku } from "../../../../lib/purchase-orders/inbound-by-sku";

/** knex here is the `__pg_connection__` pool → `?` placeholders, NOT `$1`. */
type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const sku = (req.query["sku"] as string | undefined)?.trim() ?? "";

  if (!sku) {
    res.status(400).json({ error: "sku query param is required" });
    return;
  }

  const knex = req.scope.resolve("__pg_connection__") as Knex;

  res.json(await resolveInboundBySku(knex, sku));
}
