/**
 * src/api/admin/unmet-demand/_lib/enrich-record.ts
 *
 * Shared enrichment for GET detail + PATCH responses:
 *   - customer_name / customer_email / customer_company (via Customer module)
 *   - prev_id / next_id (chronological neighbors by created_at)
 *
 * Kept in one place so the two endpoints cannot drift. Safe on customer
 * lookup failures — logs and returns nulls so the route never 500s just
 * because the customer table is temporarily unreachable.
 */

import type { AuthenticatedMedusaRequest } from "@medusajs/framework/http";
import { Modules } from "@medusajs/utils";

import type UnmetDemandModuleService from "../../../../modules/unmet-demand/service";

interface CustomerLite {
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  company_name?: string | null;
}

interface EnrichmentFields {
  customer_name: string | null;
  customer_email: string | null;
  customer_company: string | null;
  prev_id: string | null;
  next_id: string | null;
}

export async function enrichRecord(
  req: AuthenticatedMedusaRequest,
  service: UnmetDemandModuleService,
  record: Record<string, unknown>
): Promise<EnrichmentFields> {
  let customer_name: string | null = null;
  let customer_email: string | null = null;
  let customer_company: string | null = null;
  const customerId = record.customer_id as string | null;
  if (customerId) {
    try {
      const customerService = req.scope.resolve(Modules.CUSTOMER) as unknown as {
        retrieveCustomer: (id: string) => Promise<CustomerLite | null>;
      };
      const c = await customerService.retrieveCustomer(customerId);
      if (c) {
        customer_email = c.email ?? null;
        customer_company = c.company_name ?? null;
        customer_name =
          [c.first_name, c.last_name].filter(Boolean).join(" ").trim() ||
          c.company_name ||
          c.email ||
          null;
      }
    } catch (err) {
      console.error("[unmet-demand] customer lookup failed:", err);
    }
  }

  // Chronological neighbors — next = newer, prev = older
  let prev_id: string | null = null;
  let next_id: string | null = null;
  const createdAt = record.created_at as Date | string | null;
  if (createdAt) {
    const [newer, older] = (await Promise.all([
      service.listUnmetDemandRecords(
        { created_at: { $gt: createdAt } },
        { take: 1, order: { created_at: "ASC" } }
      ),
      service.listUnmetDemandRecords(
        { created_at: { $lt: createdAt } },
        { take: 1, order: { created_at: "DESC" } }
      ),
    ])) as unknown as [Array<{ id: string }>, Array<{ id: string }>];
    next_id = newer[0]?.id ?? null;
    prev_id = older[0]?.id ?? null;
  }

  return {
    customer_name,
    customer_email,
    customer_company,
    prev_id,
    next_id,
  };
}
