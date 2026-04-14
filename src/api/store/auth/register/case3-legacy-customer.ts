import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Modules as _Modules } from "@medusajs/utils";

import { buildActivationEmail } from "../../../../utils/email-templates";
import { sendMail } from "../../../../utils/mailer";

/**
 * CASE 3: Legacy Customer Activation
 * Sends activation email for customers imported from QuickBooks
 */
export async function handleLegacyCustomerActivation(
  _req: MedusaRequest,
  res: MedusaResponse,
  existingCustomer: any,
  password: string
) {
  console.log("🎯 Legacy customer - sending activation email");

  // Send activation email via mailer
  try {
    // Generate activation token
    const activationToken = Buffer.from(
      `${existingCustomer.id}:${Date.now()}`
    ).toString("base64");
    const activationLink = `${process.env.STOREFRONT_URL || "http://localhost:3000"}/activate-account?token=${activationToken}`;

    // Save temporary password and token in metadata using SQL (customerModule hangs on legacy customers)
    const postgres = await import("postgres");
    const sql = postgres.default(process.env.DATABASE_URL!);

    console.log("💾 [CHECKPOINT] Saving activation data...");
    await sql`
            UPDATE customer
            SET metadata = ${sql.json({
              legacy_customer: true,
              temporary_password: password,
              activation_token: activationToken,
              activation_expires: new Date(
                Date.now() + 24 * 60 * 60 * 1000
              ).toISOString(),
            })}
            WHERE id = ${existingCustomer.id}
        `;
    console.log("✅ [CHECKPOINT] Metadata saved");

    console.log("📧 Sending email...");

    await sendMail({
      to: existingCustomer.email,
      subject: "Activate Your Account – EcoPowerTech",
      html: buildActivationEmail(
        existingCustomer.first_name || "",
        activationLink
      ),
    });

    console.log("✅ Activation email sent successfully");

    return res.status(200).json({
      success: true,
      needs_activation: true,
      message: "Activation email sent. Please check your inbox.",
    });
  } catch (emailError) {
    console.error("❌ SendGrid error:", emailError);
    console.error("❌ Error details:", {
      message: emailError instanceof Error ? emailError.message : "Unknown",
      stack: emailError instanceof Error ? emailError.stack : undefined,
      raw: JSON.stringify(emailError, null, 2),
    });
    return res.status(500).json({
      error: "Failed to send activation email",
      details:
        emailError instanceof Error ? emailError.message : "Unknown error",
      debug: process.env.NODE_ENV === "development" ? emailError : undefined,
    });
  }
}
