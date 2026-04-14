import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

/**
 * Debug endpoint to check SendGrid configuration
 * GET /store/auth/sendgrid-debug
 */
export async function GET(_req: MedusaRequest, res: MedusaResponse) {
  const apiKey = process.env.SENDGRID_API_KEY || "NOT SET";
  const fromEmail = process.env.SENDGRID_FROM || "NOT SET";

  return res.status(200).json({
    api_key_set: !!process.env.SENDGRID_API_KEY,
    api_key_length: apiKey.length,
    api_key_preview:
      apiKey.substring(0, 20) + "..." + apiKey.substring(apiKey.length - 5),
    from_email: fromEmail,
  });
}
