import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Modules } from "@medusajs/utils";

import { ensureCustomerPipelineRow } from "../../../../../lib/quickbooks/qb-pipeline";

interface Body {
  // Core
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  company_name?: string;
  // Classification (required)
  qb_customer_type: string;
  price_level: string;
  acquisition_channel: string;
  // Alt contact
  alt_contact?: string;
  alt_phone?: string;
  alt_email?: string;
  // Notification emails
  cc_emails?: string;
  // Address
  address?: {
    address_1?: string;
    address_2?: string;
    city?: string;
    province?: string;
    postal_code?: string;
    country_code?: string;
  };
  // When set, link the new Medusa customer to an existing QB ListID instead
  // of enqueueing a pipeline row. Used when the QB customer already exists
  // and we just need a Medusa mirror.
  existing_qb_list_id?: string;
}

/**
 * POST /admin/quickbooks/customer/create-and-sync
 *
 * Creates a customer in Medusa AND enqueues a step='customer' pipeline row
 * so the QB consolidator picks it up and pushes it to QuickBooks Desktop.
 *
 * Returns immediately with the pipeline row id — the caller should poll
 * GET /admin/quickbooks/metadata?type=customer&id={customerId} to see when
 * metadata.qb_list_id gets populated.
 */
export async function POST(
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

  const body = (req.body ?? {}) as Body;

  // ── Validation: (First+Last) OR Company Name ─────────────────────────────
  const hasFullName =
    !!(body.first_name?.trim() && body.last_name?.trim());
  const hasCompany = !!body.company_name?.trim();
  if (!hasFullName && !hasCompany) {
    res.status(400).json({
      error: "Provide a Company Name, or both First and Last Name.",
    });
    return;
  }

  if (!body.qb_customer_type) {
    res.status(400).json({ error: "qb_customer_type is required" });
    return;
  }
  if (!body.price_level) {
    res.status(400).json({ error: "price_level is required" });
    return;
  }
  if (!body.acquisition_channel) {
    res.status(400).json({ error: "acquisition_channel is required" });
    return;
  }

  // Dummy email if none provided. Lowercase to match POS AddCustomerModal.
  const emailToSave = (
    body.email?.trim() || `noemail-${Date.now()}@ecopowertech.com`
  ).toLowerCase();

  const customerModule = req.scope.resolve(Modules.CUSTOMER);

  // Build address payload (only include if at least one field is set).
  const addr = body.address;
  const hasAddress =
    !!(addr?.address_1 || addr?.city || addr?.province || addr?.postal_code);

  const addresses = hasAddress
    ? [
        {
          address_1: addr?.address_1 ?? null,
          address_2: addr?.address_2 ?? null,
          city: addr?.city ?? null,
          province: addr?.province ?? null,
          postal_code: addr?.postal_code ?? null,
          country_code: addr?.country_code ?? "us",
          is_default_billing: true,
          is_default_shipping: true,
        },
      ]
    : undefined;

  // If linking to an existing QB customer, write qb_list_id straight into
  // metadata so the consolidator doesn't try to create a duplicate.
  const baseMetadata: Record<string, unknown> = {
    qb_customer_type: body.qb_customer_type,
    price_level: body.price_level,
    qb_price_level: body.price_level,
    acquisition_channel: body.acquisition_channel,
    ...(body.alt_contact ? { alt_contact: body.alt_contact } : {}),
    ...(body.alt_phone ? { alt_phone: body.alt_phone } : {}),
    ...(body.alt_email ? { alt_email: body.alt_email } : {}),
    ...(body.cc_emails ? { cc_emails: body.cc_emails } : {}),
    ...(body.existing_qb_list_id
      ? { qb_list_id: body.existing_qb_list_id }
      : {}),
  };

  let customer: any;
  try {
    customer = await customerModule.createCustomers({
      email: emailToSave,
      first_name: body.first_name?.trim() || null,
      last_name: body.last_name?.trim() || null,
      company_name: body.company_name?.trim() || null,
      phone: body.phone?.trim() || null,
      addresses,
      metadata: baseMetadata,
    });
  } catch (err: any) {
    res.status(400).json({
      error: `Failed to create customer in Medusa: ${err.message}`,
    });
    return;
  }

  // If linking to an existing QB customer, no pipeline enqueue needed.
  if (body.existing_qb_list_id) {
    res.json({
      success: true,
      customerId: customer.id,
      email: customer.email,
      pipelineRowId: null,
      status: "linked",
    });
    return;
  }

  // Otherwise: enqueue customer pipeline row — the consolidator will sync to QB
  let pipelineRowId: string | null = null;
  try {
    pipelineRowId = await ensureCustomerPipelineRow(customer.id, customer.email);
  } catch (err: any) {
    console.error(`[create-and-sync] Pipeline enqueue failed: ${err.message}`);
    // Non-fatal — customer exists, but QB sync was not enqueued
  }

  res.json({
    success: true,
    customerId: customer.id,
    email: customer.email,
    pipelineRowId,
    status: pipelineRowId ? "pending" : "queue_failed",
  });
}
