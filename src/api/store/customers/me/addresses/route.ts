
import { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import {
    createCustomerAddressesWorkflow
} from "@medusajs/medusa/core-flows";
import { z } from "zod";

// Validator for POST request
const createAddressSchema = z.object({
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    address_1: z.string(),
    address_2: z.string().optional(),
    city: z.string().optional(),
    country_code: z.string().length(2),
    province: z.string().optional(),
    postal_code: z.string().optional(),
    phone: z.string().optional(),
    company: z.string().optional(),
    metadata: z.object({
        nickname: z.string().optional(),
        is_default_billing: z.boolean().optional(),
        is_default_shipping: z.boolean().optional(),
    }).optional(),
});

export async function POST(req: MedusaRequest, res: MedusaResponse) {
    const customerId = (req as any).auth?.actor_id;
    if (!customerId) {
        res.status(401).json({ message: "Unauthorized. No customer ID found." });
        return;
    }

    // Validate body
    const validation = createAddressSchema.safeParse(req.body);
    if (!validation.success) {
        res.status(400).json({
            message: "Invalid request body",
            errors: validation.error.errors
        });
        return;
    }

    const addressData = validation.data;

    //Extract default flags from metadata (frontend contract)
    const setAsDefaultBilling = addressData.metadata?.is_default_billing === true;
    const setAsDefaultShipping = addressData.metadata?.is_default_shipping === true;

    // If setting as default, we need to first unset any existing defaults
    // This is important because Medusa uses a unique constraint: only ONE address per customer can be default
    if (setAsDefaultBilling || setAsDefaultShipping) {
        // Unset existing defaults using raw SQL (workflows don't support bulk updates)
        const knex = req.scope.resolve("db");

        if (setAsDefaultBilling) {
            await knex.raw(`
        UPDATE customer_address 
        SET is_default_billing = false 
        WHERE customer_id = ? AND is_default_billing = true
      `, [customerId]);
        }

        if (setAsDefaultShipping) {
            await knex.raw(`
        UPDATE customer_address 
        SET is_default_shipping = false 
        WHERE customer_id = ? AND is_default_shipping = true
      `, [customerId]);
        }
    }

    // Create address using Medusa native workflow with is_default_* flags
    const { result: addresses } = await createCustomerAddressesWorkflow(req.scope)
        .run({
            input: {
                addresses: [{
                    customer_id: customerId,
                    ...addressData,
                    is_default_billing: setAsDefaultBilling,
                    is_default_shipping: setAsDefaultShipping,
                    metadata: addressData.metadata || {}
                }]
            }
        });

    const newAddress = addresses[0];

    // Return customer with all addresses
    const query = req.scope.resolve("query");
    const { data: [customer] } = await query.graph({
        entity: "customer",
        fields: [
            "*",
            "addresses.*"
        ],
        filters: {
            id: customerId
        }
    });

    // Compute default address IDs from boolean flags (to match CustomerDTO interface)
    const defaultBillingAddress = customer.addresses?.find((addr: any) => addr.is_default_billing === true);
    const defaultShippingAddress = customer.addresses?.find((addr: any) => addr.is_default_shipping === true);

    const customerResponse = {
        ...customer,
        default_billing_address_id: defaultBillingAddress?.id || null,
        default_shipping_address_id: defaultShippingAddress?.id || null
    };

    res.json({ customer: customerResponse });
}
