
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
    address_name: z.string().optional(),
    metadata: z.object({
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

    // Update address using workflow
    await updateCustomerAddressesWorkflow(req.scope).run({
        input: {
            selector: { id: addressId, customer_id: customerId },
            update: {
                ...addressData,
                metadata: addressData.metadata || {}
            }
        }
    });

    console.log(`✅ Address updated: ${addressId}`);

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
        customerUpdate.billing_address_id = addressId;
        console.log(`✅ Setting customer.billing_address_id = ${addressId}`);
    }

    if (setAsDefaultShipping) {
        // Use METADATA (no native field exists for default shipping)
        customerUpdate.metadata = {
            ...(existingCustomer?.metadata || {}),
            default_shipping_address_id: addressId
        };
        console.log(`✅ Setting customer.metadata.default_shipping_address_id = ${addressId}`);
    }

    if (Object.keys(customerUpdate).length > 0) {
        await customerModule.updateCustomers(customerId, customerUpdate);
    }

    // Return updated customer
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

export async function DELETE(req: MedusaRequest, res: MedusaResponse) {
    const customerId = (req as any).auth?.actor_id;
    const addressId = req.params.address_id;

    if (!customerId) {
        res.status(401).json({ message: "Unauthorized. No customer ID found." });
        return;
    }

    if (!addressId) {
        res.status(400).json({ message: "Address ID is required" });
        return;
    }

    // Check if this was a default address and clear it from customer
    const query = req.scope.resolve("query");
    const { data: [customer] } = await query.graph({
        entity: "customer",
        fields: ["id", "billing_address_id", "metadata"],
        filters: { id: customerId }
    });

    const customerModule = req.scope.resolve("customer");
    const customerUpdate: any = {};

    // Clear billing_address_id if deleting default billing
    if (customer && (customer as any).billing_address_id === addressId) {
        customerUpdate.billing_address_id = null;
        console.log(`✅ Clearing billing_address_id (deleted address was default)`);
    }

    // Clear metadata.default_shipping_address_id if deleting default shipping
    if (customer && customer.metadata?.default_shipping_address_id === addressId) {
        customerUpdate.metadata = {
            ...(customer.metadata || {}),
            default_shipping_address_id: null
        };
        console.log(`✅ Clearing metadata.default_shipping_address_id (deleted address was default)`);
    }

    if (Object.keys(customerUpdate).length > 0) {
        await customerModule.updateCustomers(customerId, customerUpdate);
    }

    // Delete the address
    await deleteCustomerAddressesWorkflow(req.scope).run({
        input: { ids: [addressId] }
    });

    console.log(`✅ Address deleted: ${addressId}`);

    // Return updated customer
    const { data: [updatedCustomer] } = await query.graph({
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

    if (!updatedCustomer) {
        res.status(404).json({ message: "Customer not found" });
        return;
    }

    const customerResponse = {
        ...updatedCustomer,
        default_shipping_address_id: updatedCustomer.metadata?.default_shipping_address_id || null
    };

    res.json({ customer: customerResponse });
}
