import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { Modules } from "@medusajs/utils";
import {
  ensureCustomerInQb,
  syncCustomerToQb,
} from "../../../../lib/quickbooks/order-flow-core";

/**
 * POST /admin/quickbooks/customer
 *
 * Ensures the given customer exists in QuickBooks at creation time.
 * Saves the QB ListID back to customer.metadata.qb_list_id so every
 * subsequent estimate/order skips re-creation.
 *
 * Body: { customerId: string }
 * Returns: { success, qbCustomerId?, skipped?, error? }
 */
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  // Skip silently if QB order flow is disabled (dev / staging)
  if (process.env.QB_ORDER_FLOW_ENABLED !== "true") {
    res.json({
      success: true,
      skipped: true,
      skipReason: "QB_ORDER_FLOW_ENABLED is false",
    });
    return;
  }

  const { customerId } = req.body as { customerId: string };
  if (!customerId) {
    res.status(400).json({ success: false, error: "customerId is required" });
    return;
  }

  const customerModule = req.scope.resolve(Modules.CUSTOMER);

  let customer: any;
  try {
    customer = await customerModule.retrieveCustomer(customerId, {
      relations: ["addresses"],
    });
  } catch (err: any) {
    res
      .status(404)
      .json({ success: false, error: `Customer not found: ${err.message}` });
    return;
  }

  // Build the customer shape expected by ensureCustomerInQb(),
  // including address flag resolution and all QB-native metadata fields.
  const customerForQb = {
    id: customer.id,
    email: customer.email,
    first_name: customer.first_name ?? null,
    last_name: customer.last_name ?? null,
    company_name: customer.company_name ?? null,
    phone: customer.phone ?? null,
    metadata: customer.metadata ?? {},
    addresses: (customer.addresses ?? []).map((a: any) => ({
      address_1: a.address_1,
      address_2: a.address_2,
      city: a.city,
      province: a.province,
      postal_code: a.postal_code,
      is_default_billing:
        a.is_default_billing ?? a.metadata?.is_default_billing ?? false,
      is_default_shipping:
        a.is_default_shipping ?? a.metadata?.is_default_shipping ?? false,
      metadata: a.metadata ?? {},
    })),
  };

  // ensureCustomerInQb() creates the QB record and saves qb_list_id
  // back to customer.metadata in Medusa automatically.
  const result = await ensureCustomerInQb(
    customerForQb,
    customerModule,
    (msg) => console.log(msg)
  );

  res.json({
    success: result.success,
    qbCustomerId: result.qbCustomerId,
    error: result.error,
  });
}

/**
 * PUT /admin/quickbooks/customer
 *
 * Syncs customer edits from Medusa → QuickBooks via CustomerMod.
 * - If customer has qb_list_id: performs CustomerMod (update existing QB record)
 * - If no qb_list_id: falls back to CustomerAdd (create new QB record)
 *
 * Triggered after saving customer details, defaults, or updates to address book.
 * Addresses are mapped: default_billing → BillAddress, all others → ShipToAddress[].
 *
 * Body: { customerId: string }
 * Returns: { success, qbCustomerId?, error? }
 */
export async function PUT(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  if (process.env.QB_ORDER_FLOW_ENABLED !== "true") {
    res.json({
      success: true,
      skipped: true,
      skipReason: "QB_ORDER_FLOW_ENABLED is false",
    });
    return;
  }

  const { customerId } = req.body as { customerId: string };
  if (!customerId) {
    res.status(400).json({ success: false, error: "customerId is required" });
    return;
  }

  const customerModule = req.scope.resolve(Modules.CUSTOMER);

  let customer: any;
  try {
    customer = await customerModule.retrieveCustomer(customerId, {
      relations: ["addresses"],
    });
  } catch (err: any) {
    res
      .status(404)
      .json({ success: false, error: `Customer not found: ${err.message}` });
    return;
  }

  const customerForQb = {
    id: customer.id,
    email: customer.email,
    first_name: customer.first_name ?? null,
    last_name: customer.last_name ?? null,
    company_name: customer.company_name ?? null,
    phone: customer.phone ?? null,
    metadata: customer.metadata ?? {},
    addresses: (customer.addresses ?? []).map((a: any) => ({
      id: a.id,
      address_1: a.address_1,
      address_2: a.address_2,
      city: a.city,
      province: a.province,
      postal_code: a.postal_code,
      is_default_billing:
        a.is_default_billing ?? a.metadata?.is_default_billing ?? false,
      is_default_shipping:
        a.is_default_shipping ?? a.metadata?.is_default_shipping ?? false,
      metadata: a.metadata ?? {},
    })),
  };

  const result = await syncCustomerToQb(customerForQb, customerModule, (msg) =>
    console.log(msg)
  );

  res.json({
    success: result.success,
    qbCustomerId: result.qbCustomerId,
    error: result.error,
  });
}
