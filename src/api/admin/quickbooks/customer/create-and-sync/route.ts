import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Modules } from "@medusajs/utils";
import { Client } from "pg";

import { ensureCustomerPipelineRow } from "../../../../../lib/quickbooks/qb-pipeline";
import { syncCustomerToMeili } from "../../../../../lib/meilisearch/sync-customer";

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
 * Looks for an already-existing Medusa customer that this request would
 * duplicate — first by QB ListID (when linking an existing QB customer),
 * then by email. Returns the match or null. Non-throwing: a lookup failure
 * falls through to normal creation rather than blocking the cashier.
 */
async function findExistingCustomer(
  customerModule: any,
  emailToSave: string,
  rawEmail: string | undefined,
  existingQbListId: string | undefined
): Promise<{ id: string; email: string } | null> {
  // 1. By QB ListID — metadata JSON filter needs raw SQL (not exposed by the
  //    module's filter object).
  if (existingQbListId?.trim()) {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    try {
      await client.connect();
      const { rows } = await client.query(
        `SELECT id, email FROM customer
           WHERE metadata->>'qb_list_id' = $1 AND deleted_at IS NULL
           LIMIT 1`,
        [existingQbListId.trim()]
      );
      if (rows[0]) return { id: rows[0].id, email: rows[0].email };
    } catch (err: any) {
      console.error(
        `[create-and-sync] qb_list_id dup check failed: ${err.message}`
      );
    } finally {
      await client.end().catch(() => {});
    }
  }

  // 2. By email — only when a real email was supplied (skip dummy placeholders
  //    that get a unique noemail-<ts>@ address generated per request).
  if (rawEmail?.trim()) {
    try {
      const matches = await customerModule.listCustomers(
        { email: emailToSave },
        { take: 1 }
      );
      if (matches?.[0]) {
        return { id: matches[0].id, email: matches[0].email };
      }
    } catch (err: any) {
      console.error(`[create-and-sync] email dup check failed: ${err.message}`);
    }
  }

  return null;
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

  // ── Duplicate guard ─────────────────────────────────────────────────────
  // Don't create a second Medusa mirror for a QB customer that's already
  // linked (same qb_list_id), nor a second customer with the same email.
  // If a match exists we link to it (re-index + return it) instead of
  // creating a duplicate the cashier would have to clean up later.
  const existing = await findExistingCustomer(
    customerModule,
    emailToSave,
    body.email,
    body.existing_qb_list_id
  );
  if (existing) {
    // If we're linking to a QB ListID and the matched customer isn't carrying
    // it yet (e.g. matched by email), write it so the "link" is real and
    // idempotent — no duplicate, but the QB mapping actually lands.
    if (body.existing_qb_list_id) {
      const cust = await customerModule
        .retrieveCustomer(existing.id)
        .catch(() => null);
      const meta = { ...((cust as any)?.metadata ?? {}) };
      if (meta.qb_list_id !== body.existing_qb_list_id) {
        meta.qb_list_id = body.existing_qb_list_id;
        await customerModule.updateCustomers(existing.id, { metadata: meta });
      }
    }
    await syncCustomerToMeili(existing.id, req.scope);
    res.json({
      success: true,
      customerId: existing.id,
      email: existing.email,
      pipelineRowId: null,
      status: "already_exists",
    });
    return;
  }

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

  // Index the brand-new customer into MeiliSearch immediately. The direct
  // module-service call above does NOT emit `customer.created`, so the
  // auto-sync subscriber never fires — without this the customer wouldn't
  // appear in POS search until the next full resync. Non-fatal.
  await syncCustomerToMeili(customer.id, req.scope);

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
