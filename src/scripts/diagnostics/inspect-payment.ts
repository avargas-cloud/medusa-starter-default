import { MedusaContainer } from "@medusajs/framework/types";

export default async function inspectPayment({
  container,
}: {
  container: MedusaContainer;
}) {
  const query = container.resolve("query") as any;
  const args = process.argv.slice(2);
  const paymentId = args.find((a) => !a.startsWith("--"));

  if (!paymentId) {
    console.error("❌ Please provide a Customer Payment ID.");
    console.error(
      "Example: npx medusa exec ./src/scripts/diagnostics/inspect-payment.ts cpay_123"
    );
    process.exit(1);
  }

  console.log(`\n🔍 Inspecting CustomerPayment: ${paymentId} ...\n`);

  try {
    const {
      data: [payment],
    } = await query.graph({
      entity: "customer_payment",
      fields: ["*", "applications.*"],
      filters: { id: paymentId },
    });

    if (!payment) {
      console.log(
        `❌ Payment ${paymentId} not found in 'customer_payment' entity.`
      );
      return;
    }

    console.log("--- PAYMENT RESULTS ---");
    console.log(JSON.stringify(payment, null, 2));
  } catch (error) {
    console.error("❌ Error fetching payment:", error);
  }
}
