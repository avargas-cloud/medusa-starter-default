/**
 * src/api/store/users/pos-activate/route.ts
 * POST /store/users/pos-activate  — PUBLIC endpoint.
 *
 * Creates a Medusa admin user (role=member) so POS staff can login normally.
 * For re-activation (resend invite): deletes existing provider/auth identity
 * and re-registers cleanly so emailpass's internal hashing is always used.
 *
 * Body: { token: string, password: string }
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import jwt from "jsonwebtoken";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const { token, password } = req.body as { token?: string; password?: string };
  const logger = req.scope.resolve("logger") as any;
  const JWT_SECRET = process.env.JWT_SECRET || "supersecret";

  if (!token || !password) {
    return res.status(400).json({ error: "token and password are required" });
  }

  // ── 1. Verify invite JWT ───────────────────────────────────────────────────
  let decoded: {
    email: string;
    pos_user_id: string;
    type: string;
    first_name?: string;
    last_name?: string;
  };
  try {
    decoded = jwt.verify(token, JWT_SECRET) as typeof decoded;
  } catch (err: any) {
    if (err.name === "TokenExpiredError") {
      return res
        .status(400)
        .json({
          error: "Invite link has expired. Ask an admin to resend the invite.",
        });
    }
    return res.status(400).json({ error: "Invalid invite link." });
  }

  if (decoded.type !== "pos_invite") {
    return res.status(400).json({ error: "Invalid token type" });
  }

  try {
    const authModule = req.scope.resolve("auth") as any;
    const { default: postgres } = await import("postgres");
    const sql = postgres(process.env.DATABASE_URL!);

    // ── 2. Find existing emailpass identities for this email ──────────────
    // Preserve customer_id if the email already belongs to a store customer,
    // so both POS login and storefront login work after activation.
    const existing = await sql`
            SELECT ai.id as auth_identity_id, ai.app_metadata
            FROM auth_identity ai
            JOIN provider_identity pi ON pi.auth_identity_id = ai.id
            WHERE pi.entity_id = ${decoded.email}
            AND pi.provider = 'emailpass'
            AND ai.deleted_at IS NULL
        `;

    let existingUserId: string | undefined;
    let existingCustomerId: string | undefined;

    for (const row of existing) {
      const meta = row.app_metadata ?? {};
      // Preserve user_id if this was already a POS/admin identity
      if (meta.user_id) existingUserId = meta.user_id;
      // Preserve customer_id if this email is also a store customer
      if (meta.customer_id) existingCustomerId = meta.customer_id;
      // Hard-delete provider_identity + auth_identity so we can re-register cleanly
      await sql`DELETE FROM provider_identity WHERE auth_identity_id = ${row.auth_identity_id}`;
      await sql`DELETE FROM auth_identity WHERE id = ${row.auth_identity_id}`;
    }

    await sql.end();

    logger?.info?.(
      `[POS-ACTIVATE] Cleared ${existing.length} existing identities for ${decoded.email}${existingCustomerId ? ` (preserving customer_id: ${existingCustomerId})` : ""}`
    );

    // ── 3. Register fresh credentials (emailpass uses internal hash) ────────
    const authResult = await authModule.register("emailpass", {
      authScope: "user",
      body: { email: decoded.email, password },
      headers: {},
      query: {},
      url: "/auth/user/emailpass",
      protocol: "bearer",
    });

    if (!authResult.success || !authResult.authIdentity) {
      logger?.error?.(`[POS-ACTIVATE] Register failed: ${authResult.error}`);
      return res
        .status(400)
        .json({ error: authResult.error ?? "Failed to create credentials." });
    }

    logger?.info?.(
      `[POS-ACTIVATE] Auth identity created: ${authResult.authIdentity.id}`
    );

    // ── 4. Create or find Medusa admin user ────────────────────────────────
    const userModule = req.scope.resolve("user") as any;
    let userId = existingUserId;

    if (!userId) {
      const existingUsers = await userModule
        .listUsers({ email: decoded.email })
        .catch(() => []);
      if (existingUsers?.[0]?.id) {
        userId = existingUsers[0].id;
        logger?.info?.(`[POS-ACTIVATE] Existing Medusa user: ${userId}`);
      } else {
        const [createdUser] = await userModule.createUsers([
          {
            email: decoded.email,
            first_name: decoded.first_name ?? undefined,
            last_name: decoded.last_name ?? undefined,
            role: "member",
            metadata: { is_pos_staff: true },
          },
        ]);
        userId = createdUser.id;
        logger?.info?.(`[POS-ACTIVATE] Medusa user created: ${userId}`);
      }
    }

    // ── 5. Link auth_identity → Medusa user (+ preserve customer_id if merged) ──
    await authModule.updateAuthIdentities([
      {
        id: authResult.authIdentity.id,
        app_metadata: {
          actor_type: "user",
          user_id: userId,
          // If this email already existed as a store customer, inject customer_id
          // so both POS login and storefront (customer) login work from the same identity.
          ...(existingCustomerId ? { customer_id: existingCustomerId } : {}),
        },
      },
    ]);

    logger?.info?.(`[POS-ACTIVATE] ✅ Activated ${decoded.email}`);
    return res.status(200).json({ success: true });
  } catch (err: any) {
    logger?.error?.(`[POS-ACTIVATE] ❌ ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
}
