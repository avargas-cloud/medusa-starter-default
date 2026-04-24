/**
 * build-invoice-xml.ts
 * Builds and prints the QB QBXML for a given order ID (invoice path).
 * Run: npx ts-node -e "require('./src/scripts/debug/build-invoice-xml').run(1523)"
 * or:  npx medusa exec ./src/scripts/debug/build-invoice-xml.ts
 *
 * Purpose: reproduce the exact XML sent to QB bridge to diagnose 0x80040400 errors.
 */

import { getDbPool } from "../../api/utils/db-pool";
import { buildQbItems, buildShippingQbItem } from "../../lib/quickbooks/order-flow-core";
import { parseSalesRepInitials } from "../../lib/quickbooks/parse-sales-rep";

// Inline the bridge XML builders (same logic, no bridge dependency)
function escapeXml(str: string): string {
  if (!str) return "";
  return String(str)
    .replace(/[–—]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, "...")
    .replace(/ /g, " ")
    .replace(/[^\x00-\x7F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildInvoiceXml(data: any): string {
  const items = (data.items || [])
    .map((item: any) => {
      const itemRefXml = item.productId
        ? `<ItemRef><ListID>${item.productId}</ListID></ItemRef>`
        : `<ItemRef><FullName>${escapeXml(item.productName)}</FullName></ItemRef>`;

      const taxCodeXml =
        data.salesTaxCode && item.productId
          ? `<SalesTaxCodeRef><FullName>Tax</FullName></SalesTaxCodeRef>`
          : "";

      const siteXml =
        !item.noSite
          ? `<InventorySiteRef><ListID>${item.siteId || "80000001-1331053531"}</ListID></InventorySiteRef>`
          : "";

      return [
        `<InvoiceLineAdd>`,
        `  ${itemRefXml}`,
        item.desc != null ? `  <Desc>${escapeXml(String(item.desc))}</Desc>` : "",
        item.quantity !== undefined ? `  <Quantity>${item.quantity}</Quantity>` : "",
        item.unitOfMeasure ? `  <UnitOfMeasure>${escapeXml(item.unitOfMeasure)}</UnitOfMeasure>` : "",
        item.amount !== undefined
          ? `  <Amount>${Number(item.amount).toFixed(2)}</Amount>`
          : item.price !== undefined
          ? `  <Rate>${Number(item.price).toFixed(2)}</Rate>`
          : "",
        taxCodeXml ? `  ${taxCodeXml}` : "",
        siteXml ? `  ${siteXml}` : "",
        `</InvoiceLineAdd>`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");

  const taxLine =
    data.taxExempt === true || data.salesTaxCode
      ? `<ItemSalesTaxRef><FullName>${escapeXml(data.taxExempt ? "Exempt" : data.salesTaxCode)}</FullName></ItemSalesTaxRef>`
      : "";

  const inner = [
    data.customerId
      ? `<CustomerRef><ListID>${data.customerId}</ListID></CustomerRef>`
      : `<CustomerRef><FullName>${data.customerName}</FullName></CustomerRef>`,
    data.templateRef ? `<TemplateRef><FullName>${escapeXml(data.templateRef)}</FullName></TemplateRef>` : "",
    data.date ? `<TxnDate>${data.date}</TxnDate>` : "",
    data.refNumber ? `<RefNumber>${escapeXml(data.refNumber)}</RefNumber>` : "",
    data.salesRepRef ? `<SalesRepRef><FullName>${escapeXml(data.salesRepRef)}</FullName></SalesRepRef>` : "",
    taxLine,
    data.memo ? `<Memo>${escapeXml(data.memo)}</Memo>` : "",
    items,
  ]
    .filter(Boolean)
    .join("\n  ");

  return `<?xml version="1.0" encoding="utf-8"?>
<?qbxml version="10.0"?>
<QBXML>
<QBXMLMsgsRq onError="stopOnError">
<InvoiceAddRq>
  <InvoiceAdd>
  ${inner}
  </InvoiceAdd>
</InvoiceAddRq>
</QBXMLMsgsRq>
</QBXML>`;
}

export async function run(orderDisplayId: number) {
  const pool = getDbPool();

  // Fetch order
  const orderRes = await pool.query(
    `SELECT o.id, o.display_id, o.metadata FROM "order" o WHERE o.display_id = $1`,
    [orderDisplayId]
  );
  if (!orderRes.rows[0]) {
    console.error(`Order ${orderDisplayId} not found`);
    process.exit(1);
  }
  const order = orderRes.rows[0];
  console.log(`\n=== Order ${orderDisplayId} (${order.id}) ===`);
  console.log("metadata:", JSON.stringify(order.metadata, null, 2));

  // Fetch order items with variant metadata
  const itemsRes = await pool.query(
    `SELECT oli.title, oi.quantity, oli.unit_price, oli.metadata as item_meta,
            pv.sku, pv.metadata as variant_meta
     FROM order_item oi
     JOIN order_line_item oli ON oli.totals_id = oi.id
     LEFT JOIN product_variant pv ON pv.id = oli.variant_id
     WHERE oi.order_id = $1`,
    [order.id]
  );

  console.log(`\n=== Items (${itemsRes.rows.length}) ===`);
  for (const row of itemsRes.rows) {
    console.log(`- ${row.sku}: qb_id=${row.variant_meta?.quickbooks_id}, uom=${row.variant_meta?.quickbooks_uom}, is_service=${row.variant_meta?.quickbooks_is_service}`);
    console.log(`  desc from metadata: ${row.item_meta?.sales_description || "(none)"}`);
    console.log(`  desc from variant:  ${row.variant_meta?.sales_description || "(none)"}`);
  }

  // Fetch tax total
  const taxRes = await pool.query(
    `SELECT totals->>'tax_total' as tax_total FROM order_summary WHERE order_id = $1 AND totals->>'tax_total' IS NOT NULL LIMIT 1`,
    [order.id]
  );
  const taxTotal = parseFloat(taxRes.rows[0]?.tax_total || "0");
  console.log(`\n=== Tax total: ${taxTotal} ===`);

  // Fetch POS invoice
  const invRes = await pool.query(
    `SELECT invoice_number, shipping, metadata FROM pos_invoice WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [order.id]
  );
  const inv = invRes.rows[0];
  console.log(`\n=== POS Invoice: ${inv?.invoice_number}, shipping=${inv?.shipping} ===`);

  // Build QB items (same logic as buildQbItems)
  const qbItems = itemsRes.rows
    .filter((r) => r.variant_meta?.quickbooks_id)
    .map((r) => {
      const isService = !!(
        r.variant_meta?.quickbooks_is_service === true ||
        r.variant_meta?.quickbooks_is_service === "true" ||
        r.variant_meta?.quickbooks_no_site === true ||
        r.variant_meta?.quickbooks_no_site === "true"
      );
      const qty = r.quantity;
      const price = r.unit_price / 100; // unit_price in cents
      const desc = r.item_meta?.sales_description || r.variant_meta?.sales_description ||
        `${r.title || ""}${r.sku ? ` (${r.sku})` : ""}`;
      return {
        productId: r.variant_meta.quickbooks_id,
        quantity: qty,
        price,
        amount: parseFloat((price * qty).toFixed(2)),
        desc,
        unitOfMeasure: r.variant_meta?.quickbooks_uom || undefined,
        ...(isService ? { noSite: true } : {}),
      };
    });

  const salesTaxCode = taxTotal > 0 ? (process.env.QB_DEFAULT_SALES_TAX_CODE || "Sale Tax 7%") : undefined;
  const salesRep = parseSalesRepInitials(order.metadata?.sales_rep);
  const memo = inv ? `POS Invoice ${inv.invoice_number}` : `Invoice ${orderDisplayId}`;
  const customerId = order.metadata?.qb_list_id;

  const data = {
    customerId,
    date: new Date().toISOString().split("T")[0],
    templateRef: "Invoice Ecopowertech",
    salesRepRef: salesRep,
    salesTaxCode,
    memo,
    items: qbItems,
  };

  console.log(`\n=== QB Payload ===`);
  console.log(JSON.stringify(data, null, 2));

  const xml = buildInvoiceXml(data);
  console.log(`\n=== Generated QBXML ===`);
  console.log(xml);

  await pool.end();
}

// Allow direct execution: ts-node src/scripts/debug/build-invoice-xml.ts 1523
const orderArg = parseInt(process.argv[2] || "1523");
if (!isNaN(orderArg)) {
  run(orderArg).catch(console.error);
}
