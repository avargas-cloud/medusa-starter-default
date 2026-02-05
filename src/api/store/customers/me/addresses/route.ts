
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

    // Extract default flags from metadata (frontend contract)
    const setAsDefaultBilling = addressData.metadata?.is_default_billing === true;
    const setAsDefaultShipping = addressData.metadata?.is_default_shipping === true;

    // Create address using Medusa native workflow
    const { result } = await createCustomerAddressesWorkflow(req.scope)
        .run({
            input: {
                addresses: [{
                    customer_id: customerId,
                    ...addressData,
                    metadata: addressData.metadata || {}
                }]
            }
        });

    const createdAddress = result?.[0];

    if (!createdAddress) {
        res.status(500).json({ message: "Failed to create address" });
        return;
    }

    console.log(`✅ Address created: ${createdAddress.id}`);

    // Update customer default addresses using NATIVE fields
    const customerModule = req.scope.resolve("customer");
    const query = req.scope.resolve("query");

    // Get current customer to merge metadata
    const { data: [existingCustomer] } = await query.graph({
        entity: "customer",
        fields: ["id", "metadata", "billing_address_id"],
        filters: { id: customerId }
    });

    const customerUpdate: any = {};

    if (setAsDefaultBilling) {
        // Use NATIVE Medusa v2 field: billing_address_id
        customerUpdate.billing_address_id = createdAddress.id;
        console.log(`✅ Setting customer.billing_address_id = ${createdAddress.id}`);
    }

    if (setAsDefaultShipping) {
        // Use METADATA (no native field exists for default shipping)
        customerUpdate.metadata = {
            ...(existingCustomer.metadata || {}),
            default_shipping_address_id: createdAddress.id
        };
        console.log(`✅ Setting customer.metadata.default_shipping_address_id = ${createdAddress.id}`);
    }

    if (Object.keys(customerUpdate).length > 0) {
        await customerModule.updateCustomers(customerId, customerUpdate);
    }

    // Return customer with all addresses
    const { data: [customer] } = await query.graph({
        entity: "customer",
        fields: [
            "id",
            "email",
            "first_name",
            "last_name",
            "billing_address_id",
            "metadata",
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

    const customerResponse = {
        ...customer,
        default_shipping_address_id: customer.metadata?.default_shipping_address_id || null
    };

    res.json({ customer: customerResponse });
}
