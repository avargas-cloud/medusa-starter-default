
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
    address_name: z.string().optional(),
    metadata: z.object({
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

    // Extract default flags from metadata (frontend sends them here)
    const setAsDefaultBilling = addressData.metadata?.is_default_billing === true;
    const setAsDefaultShipping = addressData.metadata?.is_default_shipping === true;

    // Create address using Medusa native workflow
    // Medusa automatically handles unsetting previous defaults via maybeUnsetDefaultBillingAddressesStep
    await createCustomerAddressesWorkflow(req.scope)
        .run({
            input: {
                addresses: [{
                    customer_id: customerId,
                    first_name: addressData.first_name,
                    last_name: addressData.last_name,
                    address_1: addressData.address_1,
                    address_2: addressData.address_2,
                    city: addressData.city,
                    country_code: addressData.country_code,
                    province: addressData.province,
                    postal_code: addressData.postal_code,
                    phone: addressData.phone,
                    company: addressData.company,
                    address_name: addressData.address_name,
                    // NATIVE FIELDS - Medusa handles toggle automatically
                    is_default_billing: setAsDefaultBilling,
                    is_default_shipping: setAsDefaultShipping,
                    metadata: {} // Clear metadata, we use native fields
                }]
            }
        });

    // Return customer with all addresses
    const query = req.scope.resolve("query");
    const { data: [customer] } = await query.graph({
        entity: "customer",
        fields: [
            "id",
            "email",
            "first_name",
            "last_name",
            "addresses.*"
        ],
        filters: {
            id: customerId
        }
    });

    if (!customer) {
        res.status(404).json({ message: "Customer not found" });
        return;
    }

    res.json({ customer });
}
