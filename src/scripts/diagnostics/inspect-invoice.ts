import { MedusaContainer } from "@medusajs/framework/types";

export default async function inspectInvoice({
  container,
}: {
  container: MedusaContainer;
}) {
  const query = container.resolve("query") as any;
  const args = process.argv.slice(2);
  const invoiceId = args.find(
    (a) => a.startsWith("inv_") || a.startsWith("pinv_")
  );

  if (!invoiceId) {
    console.error("❌ Please provide an Invoice ID.");
    console.error(
      "Example: npx medusa exec ./src/scripts/diagnostics/inspect-invoice.ts inv_123"
    );
    process.exit(1);
  }

  console.log(`\n🔍 Inspecting PosInvoice: ${invoiceId} ...\n`);

  try {
    const {
      data: [invoice],
    } = await query.graph({
      entity: "pos_invoice", // Ensure this matches your data model's internally registered name
      fields: ["*", "items.*", "payment_applications.*", "tracking_links.*"],
      filters: { id: invoiceId },
    });

    if (!invoice) {
      console.log(`❌ Invoice ${invoiceId} not found in 'pos_invoice' entity.`);
      return;
    }

    console.log("--- INVOICE RESULTS ---");
    console.log(JSON.stringify(invoice, null, 2));
  } catch (error) {
    console.error("❌ Error fetching invoice:", error);
  }
}
