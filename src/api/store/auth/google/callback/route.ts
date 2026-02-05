import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Modules, ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { generateJwtToken } from "@medusajs/framework/utils";

/**
 * Google OAuth Callback Handler
 * 
 * This endpoint is called by Google after user authorizes the app.
 * It exchanges the authorization code for user info and creates/logs in the customer.
 * 
 * Pattern based on Medusa v2 Auth Technical Reference (Section 5: Step 5)
 */
export async function GET(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const authModuleService = req.scope.resolve(Modules.AUTH);
    const customerModuleService = req.scope.resolve(Modules.CUSTOMER);

    try {
        console.log('[Google OAuth Callback] Received callback from Google');
        console.log('[Google OAuth Callback] Query params:', req.query);

        // Step 1: Authenticate with Medusa's auth module
        // This exchanges the Google code for user info
        // Explicit cast to bypass DTO typing issues (see docs Section 19)
        const authResponse = await authModuleService.authenticate("google", {
            query: req.query,
            headers: req.headers,
            authScope: "store",
            protocol: req.protocol
        } as any) as any;

        console.log('[Google OAuth Callback] Auth response:', JSON.stringify(authResponse, null, 2));

        if (!authResponse.success) {
            console.error('[Google OAuth Callback] Authentication failed:', authResponse.error);
            return res.redirect(`${process.env.STOREFRONT_URL || 'http://localhost:4321'}/404?error=auth_failed`);
        }

        console.log('[Google OAuth Callback] Authentication successful');

        // Step 2: Extract email from Google profile
        // Email is in provider_metadata (see documentation Section 5)
        // Explicit cast needed for provider_metadata access
        const email = (authResponse.authIdentity as any)?.provider_metadata?.email;

        if (!email) {
            console.error('[Google OAuth Callback] No email in auth response');
            console.error('[Google OAuth Callback] AuthIdentity:', JSON.stringify(authResponse.authIdentity, null, 2));
            return res.redirect(`${process.env.STOREFRONT_URL || 'http://localhost:4321'}/404?error=no_email`);
        }

        console.log('[Google OAuth Callback] Email extracted:', email);

        // Step 3: Get or create customer (Case 1/2/3 logic)
        let customer;
        // listCustomers returns array but DTO typing is incorrect - use explicit cast
        const customersResult = await customerModuleService.listCustomers({
            email: email
        }) as any;

        const existingCustomers = customersResult[0];

        if (existingCustomers && existingCustomers.length > 0) {
            customer = existingCustomers[0];
            console.log('[Google OAuth Callback] Found existing customer:', customer.id);

            // Case 3: Legacy customer activation (if has_account is false)
            if (!customer.has_account) {
                console.log('[Google OAuth Callback] Activating legacy customer');
                // TODO: Implement legacy activation logic if needed
            }
        } else {
            // Case 1: New customer - create account
            const firstName = (authResponse.authIdentity as any)?.provider_metadata?.given_name || '';
            const lastName = (authResponse.authIdentity as any)?.provider_metadata?.family_name || '';

            console.log('[Google OAuth Callback] Creating new customer');
            customer = await customerModuleService.createCustomers({
                email: email,
                first_name: firstName,
                last_name: lastName,
                has_account: true
            });

            console.log('[Google OAuth Callback] Created new customer:', customer.id);
        }

        // Step 4: Generate JWT token (Gold Standard pattern from docs)
        const config = req.scope.resolve(ContainerRegistrationKeys.CONFIG_MODULE);
        const { http } = config.projectConfig;

        const token = generateJwtToken({
            actor_id: customer.id,
            actor_type: "customer",
            auth_identity_id: (authResponse.authIdentity as any).id,
            app_metadata: {
                customer_id: customer.id,
                provider: "google"
            }
        }, {
            secret: http.jwtSecret,
            expiresIn: http.jwtExpiresIn || "24h",
            jwtOptions: http.jwtOptions || {}
        });

        console.log('[Google OAuth Callback] Token generated successfully');

        // Step 5: Redirect to frontend with token
        const frontendCallbackUrl = `${process.env.STOREFRONT_URL || 'http://localhost:4321'}/auth/callback?token=${token}`;

        console.log('[Google OAuth Callback] Redirecting to:', frontendCallbackUrl);

        return res.redirect(frontendCallbackUrl);

    } catch (error: any) {
        console.error('[Google OAuth Callback] Error:', error);
        console.error('[Google OAuth Callback] Error stack:', error.stack);
        return res.redirect(`${process.env.STOREFRONT_URL || 'http://localhost:4321'}/404?error=server_error`);
    }
}
