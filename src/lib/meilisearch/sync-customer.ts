import { Modules } from "@medusajs/utils";

/**
 * Builds a customer's MeiliSearch document and upserts it into the
 * `customers` index.
 *
 * Single source of truth shared by:
 *   • the `customer.*` lifecycle subscriber (event-driven sync)
 *   • the QB Admin mapping routes (create-and-sync / metadata PUT), where the
 *     customer is created/updated through a *direct* module-service call that
 *     does NOT emit `customer.created`/`customer.updated`, so the subscriber
 *     never fires and the doc must be pushed explicitly.
 *
 * A customer that is GONE from the database loses its document here. That is the
 * only path that removes one, and it fires only on a provable absence — see the
 * catch block for why "provable" is doing real work in that sentence.
 *
 * Non-throwing by design, with one exception — a Meili hiccup logs and returns
 * instead of breaking the caller's primary write. The exception is a FAILED
 * DELETE, which rethrows so the queue retries it: nothing else can repair that
 * one, because the reconciliation sweep never enumerates a deleted row.
 */
export async function syncCustomerToMeili(
  customerId: string,
  container: any,
  logger?: any
): Promise<void> {
  const log = logger ?? container.resolve("logger");
  try {
    const customerModule = container.resolve(Modules.CUSTOMER);
    const customer = await customerModule.retrieveCustomer(customerId, {
      relations: ["groups"],
    });
    if (!customer) {
      log.warn(
        `[MEILI-CUSTOMER-SYNC] ⚠️  Customer ${customerId} not found, skipping`
      );
      return;
    }

    const meta = (customer.metadata as any) || {};

    const existingCustomerType =
      meta.qb_customer_type || meta.customer_type || "Standard";

    const groupNames = customer.groups?.map((g: any) => g.name) || [];
    const hasWholesaleGroup = groupNames.includes("Wholesale");
    const priceLevel =
      meta.qb_price_level ||
      meta.price_level ||
      (hasWholesaleGroup ? "Wholesale" : "Retail");

    const meiliDoc = {
      id: customer.id,
      email: (customer.email || "").toLowerCase(),
      first_name: customer.first_name || "",
      last_name: customer.last_name || "",
      company_name: meta.company_name || (customer as any).company_name || "",
      phone: customer.phone || "",
      has_account: customer.has_account,
      customer_type: existingCustomerType,
      price_level: priceLevel,
      status: customer.has_account ? "Registered" : "Guest",
      list_id: meta.qb_list_id || "",
      acquisition_channel: meta.acquisition_channel || "",
      default_tax: meta.default_tax || null,
      tax_exempt_reason: meta.tax_exempt_reason || null,
      groups: groupNames,
      updated_at: new Date(customer.updated_at).getTime(),
      created_at: new Date(customer.created_at).getTime(),
    };

    const { MeiliSearch } = await import("meilisearch");
    const client = new MeiliSearch({
      host: process.env.MEILISEARCH_HOST!,
      apiKey: process.env.MEILISEARCH_API_KEY!,
    });
    // Pin the primary key explicitly. The customer doc carries multiple
    // `*id` fields (id, list_id), so on a fresh index with no PK configured
    // Meili can't auto-detect one and rejects the batch with
    // `index_primary_key_multiple_candidates_found`. Passing it is a no-op
    // once the index already has PK "id".
    await client.index("customers").updateDocuments([meiliDoc], {
      primaryKey: "id",
    });

    log.info(
      `[MEILI-CUSTOMER-SYNC] ✅ ${customer.email} — Type: ${existingCustomerType}, Price: ${priceLevel}, Groups: ${meiliDoc.groups.join(", ") || "none"}`
    );
  } catch (err: any) {
    // A customer that is GONE has to lose its document. Nothing did that until
    // 2026-07-29, so a soft-deleted customer stayed searchable forever: three of
    // them had been sitting in the index since 2026-05-01. Measured end to end —
    // the trigger fires (as an UPDATE, since a soft delete IS an update), the
    // queue processor lands here, retrieveCustomer throws, this catch logged and
    // returned, and the queue marked the row done with the document intact.
    //
    // The delete happens ONLY on a provable absence. Medusa throws
    // `type: "not_found"` for a soft-deleted or missing customer, which is what
    // makes that distinguishable from a transient read failure — and the
    // distinction is the whole safety property here. Deleting on any error would
    // mean a Postgres hiccup silently removes a LIVE customer from search, which
    // is far worse than leaving a stale one behind. (The vendor reconciler does
    // `retrieveQbVendor(id).catch(() => null)` and deletes on null, so it still
    // has that hazard; noted, not fixed here.)
    if (err?.type === "not_found") {
      try {
        const { MeiliSearch } = await import("meilisearch");
        await new MeiliSearch({
          host: process.env.MEILISEARCH_HOST!,
          apiKey: process.env.MEILISEARCH_API_KEY!,
        })
          .index("customers")
          .deleteDocument(customerId);
        log.info(
          `[MEILI-CUSTOMER-SYNC] 🗑️  ${customerId} is gone from the database — document deleted`
        );
      } catch (delErr: any) {
        // Rethrow so the queue retries. A failed delete cannot be repaired by
        // anything else: the reconciliation sweep enumerates rows by updated_at
        // and a deleted row is never enumerated, so a swallowed failure here is
        // exactly how a permanent orphan is created. Rethrowing is safe for the
        // existing callers because this branch never ran before today.
        log.error(
          `[MEILI-CUSTOMER-SYNC] ❌ could not delete the document for ${customerId}: ${delErr.message}`
        );
        throw delErr;
      }
      return;
    }

    // Anything else stays non-throwing, as it has always been: a Meili hiccup
    // must not break the caller's primary write, and the 5-minute sweep is the
    // net for a stale document. Changing that would touch all 8 callsites,
    // including customer-facing routes, and is a separate decision.
    log.error(
      `[MEILI-CUSTOMER-SYNC] ❌ sync failed for ${customerId}: ${err.message}`
    );
  }
}
