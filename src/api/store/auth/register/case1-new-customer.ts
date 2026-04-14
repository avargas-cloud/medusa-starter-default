import { Modules } from "@medusajs/utils";
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { buildWelcomeEmail } from "../../../../utils/email-templates";
import { sendMail } from "../../../../utils/mailer";

/**
 * CASE 1: New Customer Registration
 * Creates auth identity, customer account, and auto-logs in the user
 */
export async function handleNewCustomerRegistration(
  req: MedusaRequest,
  res: MedusaResponse,
  {
    email,
    password,
    first_name,
    last_name,
  }: {
    email: string;
    password: string;
    first_name: string;
    last_name: string;
  }
) {
  console.log("🆕 New customer registration - using emailpass provider");

  try {
    const authModule = req.scope.resolve(Modules.AUTH);

    // Step 1: Use emailpass provider's register method (properly hashes password)
    const registerResult = await authModule.register("emailpass", {
      body: { email, password },
      authScope: "store",
      protocol: req.protocol,
      url: req.url,
      headers: req.headers,
      query: req.query,
    } as any);

    if (!registerResult.success || !registerResult.authIdentity) {
      console.log("❌ Registration failed:", registerResult.error);
      return res.status(400).json({
        error: "Registration failed",
        message: registerResult.error || "Could not create account",
      });
    }

    const authIdentity = registerResult.authIdentity;

    console.log(
      `✅ Auth identity created with hashed password: ${authIdentity.id}`
    );

    // Step 2: Use native Medusa workflow to create customer account
    const { createCustomerAccountWorkflow } =
      await import("@medusajs/core-flows");

    const { result: customer } = await createCustomerAccountWorkflow(
      req.scope
    ).run({
      input: {
        authIdentityId: authIdentity.id,
        customerData: {
          email,
          first_name,
          last_name,
          has_account: true,
          metadata: {
            registered_at: new Date().toISOString(),
          },
        },
      },
    });

    console.log(`✅ Customer account created via workflow: ${customer.id}`);

    // Step 2.5: Auto-assign to "Retail" customer group
    try {
      const query = req.scope.resolve("query");
      const customerModuleService = req.scope.resolve(Modules.CUSTOMER);

      // Find the Retail group
      const { data: retailGroups } = await query.graph({
        entity: "customer_group",
        fields: ["id", "name"],
        filters: { name: "Retail" },
      });

      if (retailGroups.length > 0) {
        await customerModuleService.addCustomerToGroup({
          customer_id: customer.id,
          customer_group_id: retailGroups[0]!.id, // Safe: filtered above
        });
        console.log(`✅ Customer auto-assigned to Retail group`);
      } else {
        console.log(
          `⚠️  Retail group not found - customer not assigned to any group`
        );
      }
    } catch (groupError) {
      console.log(`⚠️  Could not assign to Retail group:`, groupError);
      // Continue anyway - not critical
    }

    // Step 3: Generate JWT token with explicit actor_id
    // Using generateJwtToken directly instead of generateJwtTokenForAuthIdentity
    // because we need to explicitly control the actor_id field
    const { generateJwtToken, ContainerRegistrationKeys } =
      await import("@medusajs/utils");

    const config = req.scope.resolve(ContainerRegistrationKeys.CONFIG_MODULE);
    const { http } = config.projectConfig;

    // Create token payload with explicit customer_id as actor_id
    const token = generateJwtToken(
      {
        actor_id: customer.id, // ← CRITICAL: Explicitly set customer ID
        actor_type: "customer",
        auth_identity_id: authIdentity.id,
        app_metadata: {
          customer_id: customer.id, // Also include for consistency
        },
      },
      {
        secret: http.jwtSecret,
        expiresIn: http.jwtExpiresIn,
        jwtOptions: http.jwtOptions,
      }
    );

    console.log("✅ JWT token generated with actor_id:", customer.id);

    // DEBUG: Decode and verify token has actor_id
    const jwt = await import("jsonwebtoken");
    const decoded = jwt.decode(token) as any;
    console.log(
      "🔍 DEBUG - Token payload:",
      JSON.stringify(
        {
          actor_id: decoded?.actor_id,
          actor_type: decoded?.actor_type,
          auth_identity_id: decoded?.auth_identity_id,
          has_actor_id: !!decoded?.actor_id,
        },
        null,
        2
      )
    );

    // Step 4: Update auth identity with customer_id for future logins
    await authModule.updateAuthIdentities({
      id: authIdentity.id,
      app_metadata: {
        customer_id: customer.id,
      },
    });

    console.log("✅ Auth identity updated for future logins");
    console.log("✅ Registration complete - customer auto-logged in");

    // Step 5: Send welcome email (non-blocking)
    try {
      await sendMail({
        to: email,
        subject: `Welcome to EcoPowerTech, ${first_name}!`,
        html: buildWelcomeEmail(first_name),
      });
      console.log("📧 Welcome email sent to", email);
    } catch (emailErr) {
      console.error("⚠️  Welcome email failed (non-critical):", emailErr);
    }

    console.log("✅ Registration complete - customer linked to auth identity");

    return res.status(201).json({
      success: true,
      customer: {
        id: customer.id,
        email: customer.email,
        first_name: customer.first_name,
        last_name: customer.last_name,
      },
      token, // JWT token for session
      message: "Registration successful. You are now logged in.",
    });
  } catch (registrationError) {
    console.error("❌ Registration error:", registrationError);
    return res.status(500).json({
      error: "Registration failed",
      details:
        registrationError instanceof Error
          ? registrationError.message
          : "Unknown error",
    });
  }
}
