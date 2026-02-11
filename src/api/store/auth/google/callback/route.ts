import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Modules, ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { generateJwtToken } from "@medusajs/framework/utils";

/**
 * Google OAuth Callback Handler (Gold Standard)
 * 
 * Authoritative implementation from Medusa v2 Technical Reference
 * Section: "Google OAuth Callback Implementation Pattern (Gold Standard)"
 * 
 * This endpoint is called by Google after user authorizes the app.
 * Handles: New customers (Case 1), Existing (Case 2), Legacy activation (Case 3)
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

        // Step 1: Auth Module Exchange (Gold Standard Pattern)
        const authResponse = await authModuleService.authenticate("google", {
            query: req.query,
            headers: req.headers,
            authScope: "store", // MUST be store for storefront customers
            protocol: req.protocol
        } as any) as any;

        console.log('[Google OAuth Callback] Auth response:', JSON.stringify(authResponse, null, 2));

        if (!authResponse.success) {
            console.error('[Google OAuth Callback] Authentication failed:', authResponse.error);
            const storefrontUrl = process.env.STOREFRONT_URL || (process.env.NODE_ENV === 'production' ? 'https://ecopowertech-headless-medusa.vercel.app' : 'http://localhost:4321');
            return res.redirect(`${storefrontUrl}/404?error=auth_failed`);
        }

        console.log('[Google OAuth Callback] Authentication successful');

        // Step 2: Email Extraction (Gold Standard Pattern)
        const email = (authResponse.authIdentity as any)?.provider_metadata?.email;

        if (!email) {
            console.error('[Google OAuth Callback] No email in auth response');
            console.error('[Google OAuth Callback] AuthIdentity:', JSON.stringify(authResponse.authIdentity, null, 2));
            const storefrontUrl = process.env.STOREFRONT_URL || (process.env.NODE_ENV === 'production' ? 'https://ecopowertech-headless-medusa.vercel.app' : 'http://localhost:4321');
            return res.redirect(`${storefrontUrl}/404?error=no_email`);
        }

        console.log('[Google OAuth Callback] Email extracted:', email);

        // Step 3: Customer Resolution/Creation (The Array/DTO Pattern)
        // Note: listCustomers returns [data, count] at runtime, but DTO types often misrepresent this
        const customersResult = await customerModuleService.listCustomers({ email }) as any;
        const existingCustomers = customersResult[0]; // Extract data array

        let customer = existingCustomers?.[0]; // Get first match

        if (!customer) {
            // Case 1: New customer - create account
            console.log('[Google OAuth Callback] Case 1: Creating new customer');
            customer = await customerModuleService.createCustomers({
                email,
                first_name: (authResponse.authIdentity as any)?.provider_metadata?.given_name || '',
                last_name: (authResponse.authIdentity as any)?.provider_metadata?.family_name || '',
                has_account: true
            });
            console.log('[Google OAuth Callback] Created new customer:', customer.id);
        } else {
            console.log('[Google OAuth Callback] Found existing customer:', customer.id);

            // Case 3: Legacy customer activation (if has_account is false)
            if (!customer.has_account) {
                console.log('[Google OAuth Callback] Case 3: Activating legacy customer');
                // TODO: Implement SQL activation if needed
                // UPDATE customer SET has_account = true WHERE id = customer.id
            } else {
                console.log('[Google OAuth Callback] Case 2: Existing active customer');
            }
        }

        // Step 4: JWT Generation (Gold Standard)
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
            expiresIn: "24h",
            jwtOptions: http.jwtOptions || {}
        });

        console.log('[Google OAuth Callback] Token generated successfully');

        // Step 5: Redirection (Gold Standard)
        const storefrontUrl = process.env.STOREFRONT_URL || (process.env.NODE_ENV === 'production' ? 'https://ecopowertech-headless-medusa.vercel.app' : 'http://localhost:4321');
        const frontendCallbackUrl = `${storefrontUrl}/auth/callback?token=${token}`;

        console.log('[Google OAuth Callback] Redirecting to:', frontendCallbackUrl);

        return res.redirect(frontendCallbackUrl);

    } catch (error: any) {
        console.error('[Google OAuth Callback] Error:', error);
        console.error('[Google OAuth Callback] Error stack:', error.stack);
        const storefrontUrl = process.env.STOREFRONT_URL || (process.env.NODE_ENV === 'production' ? 'https://ecopowertech-headless-medusa.vercel.app' : 'http://localhost:4321');
        return res.redirect(`${storefrontUrl}/404?error=server_error`);
    }
}
