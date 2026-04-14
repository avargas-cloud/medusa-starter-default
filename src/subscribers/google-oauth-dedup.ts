/**
 * customer-email-dedup.ts  (was: google-oauth-dedup.ts)
 *
 * Prevents duplicate customer accounts whenever Medusa creates a new customer
 * for an email that already exists — covers Google OAuth, guest checkouts that
 * trigger customer creation, and any other code path that calls customer.created.
 *
 * Root cause this guards against: Medusa's internal customer lookup is case-sensitive.
 * A browser submitting "user@email.com" when the DB has "USER@EMAIL.COM" causes Medusa
 * to create a second "zombie" customer with an empty name. This subscriber detects
 * the duplicate via a case-insensitive SQL query and merges it immediately.
 *
 * Merge strategy:
 * 1. Find ALL customers with the same email (LOWER comparison) excluding the new one
 * 2. Pick the master: has_account=true preferred, then oldest created_at
 * 3. Re-link auth_identity and orders from the new zombie → master
 * 4. Soft-delete the zombie
 */

import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import { Modules, ContainerRegistrationKeys } from "@medusajs/utils";
import type { ICustomerModuleService } from "@medusajs/types";
import postgres from "postgres";

export default async function googleOAuthDedupSubscriber({
  event,
  container,
}: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const customerModule: ICustomerModuleService = container.resolve(
    Modules.CUSTOMER
  );

  const newCustomerId = event.data.id;
  if (!newCustomerId) return;

  try {
    // Fetch the newly created customer
    const newCustomer = await customerModule.retrieveCustomer(newCustomerId, {
      select: ["id", "email", "has_account", "created_at"],
    });

    if (!newCustomer?.email) return;

    const email = newCustomer.email.toLowerCase();

    // Skip if it's a placeholder/dummy email
    if (email.startsWith("customer-") && email.includes("@ecopowertech.com"))
      return;

    // Safety guard: only auto-merge if the new customer has no qb_list_id in metadata.
    // QB-imported customers always have qb_list_id — the same email may legitimately
    // belong to two different companies in QuickBooks, so we must NOT auto-merge those.
    // Zombie customers from Vercel deploys never have qb_list_id (they're created by
    // Medusa's updateCartWorkflow which only receives the email, not QB metadata).
    const newMeta = (newCustomer as any).metadata as Record<
      string,
      unknown
    > | null;
    if (newMeta?.qb_list_id) {
      logger.info(
        `[Email Dedup] Skipping ${email} — new customer has qb_list_id, may be a legitimate QB duplicate`
      );
      return;
    }

    // Look up ALL customers with the same email using case-insensitive SQL.
    // NOTE: customerModule.listAndCountCustomers({ email }) is case-sensitive and
    // will NOT find "USER@EMAIL.COM" when searching for "user@email.com". We use
    // raw SQL with LOWER() to catch all case-variant duplicates.
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const existing = await sql<
        Array<{
          id: string;
          email: string;
          has_account: boolean;
          created_at: Date;
        }>
      >`
                SELECT id, email, has_account, created_at
                FROM customer
                WHERE LOWER(email) = ${email}
                  AND id != ${newCustomerId}
                  AND deleted_at IS NULL
                ORDER BY created_at ASC
            `;

      if (existing.length === 0) {
        // No duplicate — new customer is unique, no action needed
        return;
      }

      const masterCustomer = existing.sort((a, b) => {
        if (a.has_account && !b.has_account) return -1;
        if (!a.has_account && b.has_account) return 1;
        return (
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        );
      })[0];

      if (!masterCustomer) return;

      logger.info(
        `[Email Dedup] Duplicate detected for ${email}: new=${newCustomerId}, master=${masterCustomer.id}`
      );

      // Re-link auth_identity from new customer → master customer in the DB
      const updated = await sql`
                UPDATE auth_identity
                SET app_metadata = jsonb_set(app_metadata, '{customer_id}', ${`"${masterCustomer.id}"`}::jsonb)
                WHERE app_metadata->>'customer_id' = ${newCustomerId}
                RETURNING id
            `;
      if (updated.length > 0) {
        logger.info(
          `[Email Dedup] Re-linked ${updated.length} auth_identity record(s) to master customer ${masterCustomer.id}`
        );
      }

      // Re-assign any orders linked to the new duplicate customer
      const ordersUpdated = await sql`
                UPDATE "order"
                SET customer_id = ${masterCustomer.id}
                WHERE customer_id = ${newCustomerId}
            `;
      if (ordersUpdated.count > 0) {
        logger.info(
          `[Email Dedup] Re-assigned ${ordersUpdated.count} orders to master customer`
        );
      }

      // Soft-delete the duplicate new customer
      await customerModule.deleteCustomers([newCustomerId]);
      logger.info(
        `[Email Dedup] ✅ Soft-deleted duplicate customer ${newCustomerId} — user will log in as ${masterCustomer.id}`
      );
    } finally {
      await sql.end();
    }
  } catch (err: any) {
    // Non-fatal: log but don't block
    logger.error(
      `[Email Dedup] Error during dedup for customer ${newCustomerId}: ${err.message}`
    );
  }
}

export const config: SubscriberConfig = {
  event: "customer.created",
  context: {
    subscriberId: "customer-email-dedup",
  },
};
