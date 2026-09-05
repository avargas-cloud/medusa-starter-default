import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Modules } from "@medusajs/utils";
import jwt from "jsonwebtoken";
import postgres from "postgres";

/**
 * POST /store/users/pos-reset-confirm
 *
 * Verifies the JWT reset token, then updates the admin user's password using
 * the SQL-surgery approach (same pattern as /store/auth/reset-password/confirm):
 *
 *  1. Verify JWT → extract email
 *  2. Find existing auth_identity via provider_identity.entity_id
 *  3. Delete old provider_identity (emailpass)
 *  4. authModule.register() → creates fresh auth_identity + hashed provider_identity
 *  5. Move new provider_identity → existing auth_identity (via SQL UPDATE)
 *  6. Delete temp auth_identity
 *
 * WHY SQL SURGERY (intentional, do not "simplify"):
 * authModule.updateProvider() has a Medusa v2 bug where it creates a second
 * provider_identity instead of updating the existing one, leaving zombie records
 * that cause login failures. This 6-step approach is the only reliable way to
 * update a hashed password without creating duplicates. Steps 87-93 also clean
 * up any zombies left by previous failed attempts.
 * TODO(medusa-upgrade): re-evaluate when updateProvider() is fixed upstream.
 *
 * Body: { email: string, token: string, password: string }
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const { email, token, password } = req.body as {
    email?: string;
    token?: string;
    password?: string;
  };

  if (!email || !token || !password) {
    return res
      .status(400)
      .json({ error: "email, token, and password are required" });
  }

  if (password.length < 8) {
    return res
      .status(400)
      .json({ error: "Password must be at least 8 characters" });
  }

  const logger = req.scope.resolve("logger") as any;
  // SIN fallback. El valor por defecto era la cadena PUBLICA "supersecret":
  // faltando la env var, cualquiera podia firmar un token valido con ella y —
  // por `pos-activate`, que es publica— crearse una cuenta admin de Medusa.
  //
  // El chequeo va ACA, en el primer uso, y no en el import: un throw a nivel de
  // modulo tumba tambien el build, las migraciones y los workers, que no
  // necesitan este secreto para nada.
  const JWT_SECRET = process.env.JWT_SECRET;
  if (!JWT_SECRET) {
    logger.error(
      "[POS reset confirm] JWT_SECRET no esta configurado - operacion rechazada"
    );
    return res.status(500).json({ error: "Server misconfiguration" });
  }

  try {
    // ── Step 1: Verify JWT ─────────────────────────────────────────────────
    let payload: { email: string; type: string };
    try {
      payload = jwt.verify(token, JWT_SECRET) as {
        email: string;
        type: string;
      };
    } catch (jwtErr: any) {
      logger?.warn?.(`[POS-CONFIRM] JWT invalid: ${jwtErr.message}`);
      return res.status(400).json({
        error: "Invalid or expired reset link. Please request a new one.",
      });
    }

    if (payload.type !== "pos_reset" || payload.email !== email) {
      return res.status(400).json({ error: "Invalid reset link" });
    }

    // ── Step 2: Find the correct auth_identity for this admin user ─────────
    // Prefer the one where auth_identity.app_metadata has a user_id (admin user link).
    // Also clean up any zombie identities created by failed previous attempts.
    const sql = postgres(process.env.DATABASE_URL!);
    const authModule = req.scope.resolve(Modules.AUTH) as any;

    const providers = await sql`
            SELECT pi.id as provider_id, pi.auth_identity_id,
                   ai.app_metadata
            FROM provider_identity pi
            JOIN auth_identity ai ON ai.id = pi.auth_identity_id
            WHERE pi.entity_id = ${email}
            AND pi.provider = 'emailpass'
            ORDER BY (ai.app_metadata->>'user_id' IS NOT NULL) DESC,
                     pi.created_at ASC
        `;

    if (!providers.length) {
      await sql.end();
      return res.status(400).json({ error: "No account found for this email" });
    }

    // Pick the one linked to the admin user (has user_id in app_metadata)
    const existingProvider = (providers.find(
      (p: any) => p.app_metadata?.user_id
    ) ?? providers[0]) as {
      provider_id: string;
      auth_identity_id: string;
      app_metadata: any;
    };

    if (!existingProvider) {
      await sql.end();
      return res.status(400).json({ error: "No account found for this email" });
    }

    const existingAuthIdentityId = existingProvider.auth_identity_id;

    // Clean up zombie provider_identities (all others for this email)
    const zombieIds = providers
      .filter((p: any) => p.provider_id !== existingProvider.provider_id)
      .map((p: any) => p.provider_id as string);
    if (zombieIds.length) {
      await sql`DELETE FROM provider_identity WHERE id IN ${sql(zombieIds)}`;
      logger?.info?.(
        `[POS-CONFIRM] Cleaned ${zombieIds.length} zombie provider_identities`
      );
    }

    // ── Step 3: Delete old provider_identity ──────────────────────────────
    await sql`
            DELETE FROM provider_identity
            WHERE id = ${existingProvider.provider_id}
        `;
    logger?.info?.(`[POS-CONFIRM] Old provider_identity deleted for ${email}`);

    // ── Step 4: Register new identity to get hashed password ──────────────
    const authResult = await authModule.register("emailpass", {
      body: { email, password },
    } as any);

    if (!authResult?.success || !authResult?.authIdentity) {
      await sql.end();
      return res
        .status(500)
        .json({ error: "Password update failed during registration" });
    }

    // ── Step 5: Move new provider_identity to the existing auth_identity ──
    const [newProvider] = await sql`
            SELECT id FROM provider_identity
            WHERE auth_identity_id = ${authResult.authIdentity.id}
            AND provider = 'emailpass'
        `;

    await sql`
            UPDATE provider_identity
            SET auth_identity_id = ${existingAuthIdentityId}
            WHERE id = ${newProvider!.id}
        `;

    // ── Step 6: Delete temporary auth_identity ────────────────────────────
    await sql`
            DELETE FROM auth_identity
            WHERE id = ${authResult.authIdentity.id}
        `;

    await sql.end();

    logger?.info?.(`[POS-CONFIRM] ✅ Password updated for ${email}`);
    return res.status(200).json({ success: true });
  } catch (err: any) {
    logger?.error?.(`[POS-CONFIRM] ❌ ${err.message}`);
    return res
      .status(500)
      .json({ error: "Failed to reset password. Please try again." });
  }
}
