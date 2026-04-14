import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  console.log("\n" + "=".repeat(80));
  console.log("🔍 CUSTOM /store/shipping-options ENDPOINT CALLED");
  console.log("=".repeat(80));
  console.log("Query params:", req.query);
  console.log("Cart ID:", req.query.cart_id);
  console.log("=".repeat(80) + "\n");

  // Forward to the default Medusa handler
  // This is just for logging, the actual endpoint is handled by Medusa
  res.status(200).json({ message: "Logging endpoint" });
}
