import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Modules } from "@medusajs/utils";

/**
 * Google OAuth Initiate Endpoint
 *
 * This endpoint starts the Google OAuth flow by redirecting the user to Google's authorization page.
 *
 * Flow:
 * 1. User clicks "Login with Google" → hits this endpoint
 * 2. This redirects to Google OAuth consent screen
 * 3. User authorizes → Google redirects to /auth/customer/google/callback
 * 4. Callback handler creates/logs in customer and generates JWT
 *
 * Pattern based on Medusa v2 Auth Documentation (Section 5: OAuth Flow)
 */
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const authModuleService = req.scope.resolve(Modules.AUTH);

  try {
    console.log("[Google OAuth Initiate] Starting OAuth flow");
    console.log("[Google OAuth Initiate] Query params:", req.query);

    // Optional: capture return URL for post-login redirect
    const callbackUrl = req.query.callback_url as string | undefined;

    // Initiate Google OAuth flow
    // This method generates the authorization URL and redirects
    const result = (await authModuleService.authenticate("google", {
      query: {
        ...req.query,
        ...(callbackUrl && {
          state: JSON.stringify({ callback_url: callbackUrl }),
        }),
      },
      headers: req.headers,
      authScope: "store", // Important: scope must be "store" for customer auth
      // Force HTTPS in production (behind proxy)
      protocol: process.env.NODE_ENV === "production" ? "https" : req.protocol,
      host: req.headers.host, // CRITICAL: Railway needs explicit host for redirect_uri
    } as any)) as any; // Type cast to bypass strict DTO typing (see Medusa docs Section 19)

    // Extract redirect location
    const redirectLocation = result.location || result.url;

    if (!redirectLocation) {
      throw new Error("OAuth provider did not return a redirect URL");
    }

    console.log(
      "[Google OAuth Initiate] Redirect URL generated:",
      redirectLocation
    );

    // Redirect to Google OAuth consent screen
    return res.redirect(redirectLocation as string);
  } catch (error: any) {
    console.error("[Google OAuth Initiate] Error:", error);
    console.error("[Google OAuth Initiate] Error stack:", error.stack);

    // Redirect to login page with error
    const storefrontUrl = process.env.STOREFRONT_URL || "http://localhost:4321";
    return res.redirect(`${storefrontUrl}/login?error=oauth_initiate_failed`);
  }
}

// Support POST method as well (some implementations use POST for initiate)
export const POST = GET;
