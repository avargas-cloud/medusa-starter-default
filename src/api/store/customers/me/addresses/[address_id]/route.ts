
import { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import {
    updateCustomerAddressesWorkflow,
    deleteCustomerAddressesWorkflow
} from "@medusajs/medusa/core-flows";
import { z } from "zod";

// Validator for POST request (UPDATE)
const updateAddressSchema = z.object({
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    address_1: z.string().optional(),
    address_2: z.string().optional(),
    city: z.string().optional(),
    country_code: z.string().length(2).optional(),
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
    const addressId = req.params.address_id;

    if (!customerId) {
        res.status(401).json({ message: "Unauthorized. No customer ID found." });
        return;
    }

    // Validate body
    const validation = updateAddressSchema.safeParse(req.body);
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

    // If setting as default, unset any existing defaults
    if (setAsDefaultBilling || setAsDefaultShipping) {
        const knex = req.scope.resolve("db") as any;

        if (setAsDefaultBilling) {
            await knex.raw(`
                UPDATE customer_address 
                SET is_default_billing = false 
                WHERE customer_id = ? AND is_default_billing = true AND id != ?
            `, [customerId, addressId]);
        }

        if (setAsDefaultShipping) {
            await knex.raw(`
                UPDATE customer_address 
                SET is_default_shipping = false 
                WHERE customer_id = ? AND is_default_shipping = true AND id != ?
            `, [customerId, addressId]);
        }
    }

    // Update address using workflow with native is_default_* flags
    await updateCustomerAddressesWorkflow(req.scope).run({
        input: {
            selector: { id: addressId, customer_id: customerId },
            update: {
                ...addressData,
                is_default_billing: setAsDefaultBilling,
                is_default_shipping: setAsDefaultShipping,
            }
        }
    });

    // Return updated customer
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

    // Compute default address IDs from boolean flags
    const defaultBillingAddress = customer.addresses?.find((addr: any) => addr.is_default_billing === true);
    const defaultShippingAddress = customer.addresses?.find((addr: any) => addr.is_default_shipping === true);

    const customerResponse = {
        ...customer,
        default_billing_address_id: defaultBillingAddress?.id || null,
        default_shipping_address_id: defaultShippingAddress?.id || null
    };

    res.json({ customer: customerResponse });
}

export async function DELETE(req: MedusaRequest, res: MedusaResponse) {
    const customerId = (req as any).auth?.actor_id;
    const addressId = req.params.address_id;

    if (!customerId) {
        res.status(401).json({ message: "Unauthorized. No customer ID found." });
        return;
    }

    await deleteCustomerAddressesWorkflow(req.scope).run({
        input: { ids: [addressId] }
    });

    // Return customer
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

    // Compute default address IDs
    const defaultBillingAddress = customer.addresses?.find((addr: any) => addr.is_default_billing === true);
    const defaultShippingAddress = customer.addresses?.find((addr: any) => addr.is_default_shipping === true);

    const customerResponse = {
        ...customer,
        default_billing_address_id: defaultBillingAddress?.id || null,
        default_shipping_address_id: defaultShippingAddress?.id || null
    };

    res.json({ customer: customerResponse });
}
