
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
    const customerId = (req as any).auth_context?.actor_id;
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

    // Extract default flags from REQUEST BODY (frontend sends them at root level, NOT in metadata)
    const setAsDefaultBilling = (req.body as any).is_default_billing === true;
    const setAsDefaultShipping = (req.body as any).is_default_shipping === true;

    console.log('[UPDATE ADDRESS] 🔍 Extracted flags:', {
        setAsDefaultBilling,
        setAsDefaultShipping,
        addressId,
        customerId
    });

    // First, if setting as default, we need to UNSET all other addresses
    if (setAsDefaultBilling || setAsDefaultShipping) {
        const query = req.scope.resolve("query");
        const { data: allAddresses } = await query.graph({
            entity: "customer_address",
            fields: ["id", "metadata"],
            filters: {
                customer_id: customerId,
                id: { $ne: addressId } // All addresses EXCEPT the one we're updating
            }
        });

        console.log('[UPDATE ADDRESS] 📋 Found', allAddresses?.length || 0, 'other addresses to update');

        // Update each other address to UNSET the default flags
        if (allAddresses && allAddresses.length > 0) {
            for (const otherAddress of allAddresses) {
                const updatedMetadata = { ...(otherAddress.metadata || {}) };

                if (setAsDefaultBilling) {
                    updatedMetadata.is_default_billing = false;
                }
                if (setAsDefaultShipping) {
                    updatedMetadata.is_default_shipping = false;
                }

                console.log('[UPDATE ADDRESS] 🔄 Unsetting defaults on address:', otherAddress.id);

                // Update BOTH metadata AND native fields for compatibility
                await updateCustomerAddressesWorkflow(req.scope).run({
                    input: {
                        selector: { id: otherAddress.id, customer_id: customerId },
                        update: {
                            metadata: updatedMetadata,
                            // Also try to update native fields (even though Medusa may ignore them)
                            is_default_billing: setAsDefaultBilling ? false : undefined,
                            is_default_shipping: setAsDefaultShipping ? false : undefined
                        }
                    }
                });
            }
        }
    }

    // Now update the target address with the new data AND set it as default
    const updatedMetadata = {
        ...(addressData.metadata || {}),
        is_default_billing: setAsDefaultBilling,
        is_default_shipping: setAsDefaultShipping
    };

    console.log('[UPDATE ADDRESS] ✅ Updating target address with metadata:', updatedMetadata);

    // Update address using workflow - set BOTH metadata AND native fields
    await updateCustomerAddressesWorkflow(req.scope).run({
        input: {
            selector: { id: addressId, customer_id: customerId },
            update: {
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
                metadata: updatedMetadata,
                // ALSO update native fields (for full compatibility)
                is_default_billing: setAsDefaultBilling,
                is_default_shipping: setAsDefaultShipping
            }
        }
    });

    // Return updated customer
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

export async function DELETE(req: MedusaRequest, res: MedusaResponse) {
    const customerId = (req as any).auth_context?.actor_id;
    const addressId = req.params.address_id;

    if (!customerId) {
        res.status(401).json({ message: "Unauthorized. No customer ID found." });
        return;
    }

    if (!addressId) {
        res.status(400).json({ message: "Address ID is required" });
        return;
    }

    // Delete the address - Medusa handles everything
    await deleteCustomerAddressesWorkflow(req.scope).run({
        input: { ids: [addressId] }
    });

    // Return updated customer
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
