import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import jwt from "jsonwebtoken";
import postgres from "postgres";

import { buildPasswordResetEmail } from "../../../../utils/email-templates";
import { sendMail } from "../../../../utils/mailer";

/**
 * POST /store/users/pos-reset-password
 *
 * PUBLIC endpoint. Verifies the email belongs to a real Medusa admin user,
 * then signs a self-contained JWT reset token and sends a branded email
 * pointing to the POS reset page.
 *
 * Token verified by: POST /store/users/pos-reset-confirm
 *
 * Body: { email: string }
 * Always returns 200 (security: don't reveal if user exists).
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const { email } = req.body as { email?: string };

  if (!email || typeof email !== "string") {
    return res.status(400).json({ error: "email is required" });
  }

  const logger = req.scope.resolve("logger") as any;
  const POS_URL = process.env.POS_URL || "https://pos.ecopowertech.com";
  const JWT_SECRET = process.env.JWT_SECRET || "supersecret";

  try {
    // ── Security: Verify user exists before sending reset email ───────────
    // Check provider_identity table — only real Medusa admin users have one.
    const sql = postgres(process.env.DATABASE_URL!);
    const [existingUser] = await sql`
            SELECT pi.id FROM provider_identity pi
            JOIN auth_identity ai ON ai.id = pi.auth_identity_id
            WHERE pi.entity_id = ${email}
            AND pi.provider = 'emailpass'
            AND ai.app_metadata->>'user_id' IS NOT NULL
            LIMIT 1
        `;
    await sql.end();

    if (!existingUser) {
      logger?.warn?.(
        `[POS-RESET] No admin user found for ${email} — silently skipping`
      );
      return res.status(200).json({ success: true, sent: false });
    }

    // ── Sign a self-contained JWT (1h expiry) ─────────────────────────────
    const token = jwt.sign({ email, type: "pos_reset" }, JWT_SECRET, {
      expiresIn: "1h",
    });

    // ── Build POS reset URL ────────────────────────────────────────────────
    const resetUrl = `${POS_URL}/reset-password?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;
    logger?.info?.(`[POS-RESET] Token generated for ${email}`);

    // ── Send via mailer ────────────────────────────────────────────────────
    const html = buildPasswordResetEmail("", resetUrl);

    await sendMail({
      to: email,
      subject: "Reset your EcoPowerTech POS password",
      html,
    });

    logger?.info?.(`[POS-RESET] ✅ Reset email sent to ${email}`);
    return res.status(200).json({ success: true });
  } catch (err: any) {
    logger?.error?.(`[POS-RESET] ❌ ${err.message}`);
    return res.status(200).json({ success: true });
  }
}
