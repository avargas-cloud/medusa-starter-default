/**
 * Backfill missing $0 order lines into POS Invoice 20246 for Medusa order 1652.
 *
 * Context: order 1652 intentionally has real product lines at unit_price=0
 * (customer concession). The fulfillment/allocation repair handled those lines,
 * but the imported POS invoice snapshot was missing them, so the POS invoice UI
 * did not show them as invoiced.
 *
 * Dry-run:
 *   yarn medusa exec ./src/scripts/fix/fix-order-1652-zero-price-invoice-items.ts
 *
 * Apply:
 *   APPLY=1 yarn medusa exec ./src/scripts/fix/fix-order-1652-zero-price-invoice-items.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";

import { INVOICE_MODULE } from "../../modules/invoices";

const ORDER_ID = "order_01KQMSZSWXFS3C9NDVNF1Q4GZN";
const INVOICE_ID = "01KQN88KTJCC5S9KYNBQWQ07D9";

interface ZeroLine {
  line_item_id: string;
  variant_id: string | null;
  sku: string | null;
  description: string;
  quantity: number;
  sort_order: number;
}

export default async function fixOrder1652ZeroPriceInvoiceItems({
  container,
}: ExecArgs) {
  const apply = process.env.APPLY === "1";
  const logger = container.resolve("logger");
  const pg = container.resolve("__pg_connection__") as any;
  const invoiceService: any = container.resolve(INVOICE_MODULE);

  logger.info(
    `${apply ? "APPLY" : "DRY-RUN"} $0 invoice item backfill for order 1652 / invoice 20246`
  );

  const invoiceRows = (
    await pg.raw(
      `SELECT id, invoice_number, status, total, amount_paid, balance_due
         FROM pos_invoice
        WHERE id = ?
          AND order_id = ?
          AND deleted_at IS NULL
        LIMIT 1`,
      [INVOICE_ID, ORDER_ID]
    )
  ).rows;
  const invoice = invoiceRows[0];
  if (!invoice) {
    throw new Error(`Invoice ${INVOICE_ID} not found for order ${ORDER_ID}`);
  }
  if (invoice.status === "voided" || invoice.status === "draft") {
    throw new Error(`Invoice ${invoice.invoice_number} is ${invoice.status}`);
  }

  const zeroLines = (
    await pg.raw(
      `
      SELECT DISTINCT ON (oli.id)
        oli.id AS line_item_id,
        oli.variant_id,
        oli.variant_sku AS sku,
        COALESCE(
          NULLIF(oli.metadata->>'sales_description', ''),
          NULLIF(oli.title, ''),
          oli.variant_sku,
          oli.id
        ) AS description,
        oi.quantity::int AS quantity,
        COALESCE((oli.metadata->>'sort_order')::int, 9999) AS sort_order
      FROM order_item oi
      JOIN order_line_item oli ON oli.id = oi.item_id
      WHERE oi.order_id = ?
        AND oi.deleted_at IS NULL
        AND oli.deleted_at IS NULL
        AND oi.quantity > 0
        AND oi.unit_price = 0
      ORDER BY oli.id, oi.version DESC
      `,
      [ORDER_ID]
    )
  ).rows as ZeroLine[];

  if (!zeroLines.length) {
    logger.info("No $0 order lines found.");
    return;
  }

  const existingZeroRows = (
    await pg.raw(
      `SELECT sku, variant_id, SUM(quantity)::int AS quantity
         FROM pos_invoice_item
        WHERE invoice_id = ?
          AND deleted_at IS NULL
          AND total = 0
        GROUP BY sku, variant_id`,
      [INVOICE_ID]
    )
  ).rows as Array<{
    sku: string | null;
    variant_id: string | null;
    quantity: number;
  }>;

  const consumed = new Map<string, number>();
  for (const row of existingZeroRows) {
    const key = `${row.variant_id ?? ""}|${row.sku ?? ""}`;
    consumed.set(key, Number(row.quantity ?? 0));
  }

  const toCreate: ZeroLine[] = [];
  for (const line of zeroLines.sort((a, b) => a.sort_order - b.sort_order)) {
    const key = `${line.variant_id ?? ""}|${line.sku ?? ""}`;
    const alreadyAvailable = consumed.get(key) ?? 0;
    if (alreadyAvailable >= line.quantity) {
      consumed.set(key, alreadyAvailable - line.quantity);
      continue;
    }
    if (alreadyAvailable > 0) {
      consumed.set(key, 0);
      toCreate.push({ ...line, quantity: line.quantity - alreadyAvailable });
      continue;
    }
    toCreate.push(line);
  }

  logger.info("Missing $0 invoice snapshot lines:");
  if (!toCreate.length) {
    logger.info("  none");
    return;
  }
  for (const line of toCreate) {
    logger.info(`  ${line.sku ?? line.variant_id ?? line.line_item_id} x${line.quantity}`);
  }

  if (!apply) {
    logger.info("Dry-run only. Re-run with APPLY=1 to insert missing invoice items.");
    return;
  }

  await invoiceService.createPosInvoiceItems(
    toCreate.map((line) => ({
      invoice_id: INVOICE_ID,
      variant_id: line.variant_id,
      sku: line.sku,
      description: line.description,
      quantity: line.quantity,
      unit_price: 0,
      total: 0,
      attached_image: null,
      taxable: true,
    }))
  );

  const check = (
    await pg.raw(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(total), 0)::numeric AS total
         FROM pos_invoice_item
        WHERE invoice_id = ?
          AND deleted_at IS NULL`,
      [INVOICE_ID]
    )
  ).rows[0];

  logger.info(
    `Backfill complete. Invoice now has ${check.count} item rows; item total sum=${check.total}. Invoice total remains ${invoice.total}.`
  );
}
