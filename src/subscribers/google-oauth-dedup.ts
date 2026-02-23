/**
 * google-oauth-dedup.ts
 *
 * Prevents duplicate customer accounts when Google OAuth creates a new customer
 * for an email that already exists in Medusa.
 *
 * Problem: When a user logs in via Google OAuth for the first time, Medusa creates
 * a new customer. If a customer with the same email already exists (e.g., a QB
 * legacy import, or a previous email+password registration), two accounts exist
 * for the same email. This subscriber merges them by:
 * 1. Finding the existing customer with the same email
 * 2. Re-linking the new auth_identity to the existing customer
 * 3. Soft-deleting the newly created duplicate customer
 *
 * This ensures both Google OAuth AND email+password login land on the same account.
 */

import type { SubscriberArgs, SubscriberConfig } from '@medusajs/framework'
import { Modules, ContainerRegistrationKeys } from '@medusajs/framework/utils'
import type { ICustomerModuleService } from '@medusajs/types'
import postgres from 'postgres'

export default async function googleOAuthDedupSubscriber({
    event,
    container
}: SubscriberArgs<{ id: string }>) {
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
    const customerModule: ICustomerModuleService = container.resolve(Modules.CUSTOMER)

    const newCustomerId = event.data.id
    if (!newCustomerId) return

    try {
        // Fetch the newly created customer
        const newCustomer = await customerModule.retrieveCustomer(newCustomerId, {
            select: ['id', 'email', 'has_account', 'created_at']
        })

        if (!newCustomer?.email) return

        const email = newCustomer.email.toLowerCase()

        // Skip if it's a placeholder/dummy email
        if (email.startsWith('customer-') && email.includes('@ecopowertech.com')) return

        // Look up ALL customers with this email (may include the one just created)
        const [allWithEmail] = await customerModule.listAndCountCustomers(
            { email },
            { select: ['id', 'email', 'has_account', 'created_at'], take: 10 }
        )

        // Filter out the newly created customer — we need *other* pre-existing ones
        const existing = allWithEmail.filter(c => c.id !== newCustomerId)

        if (existing.length === 0) {
            // No duplicate — new customer is unique, no action needed
            return
        }

        const masterCustomer = existing.sort((a, b) => {
            if (a.has_account && !b.has_account) return -1
            if (!a.has_account && b.has_account) return 1
            return new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        })[0]

        if (!masterCustomer) return

        logger.info(`[OAuth Dedup] Duplicate detected for ${email}: new=${newCustomerId}, master=${masterCustomer.id}`)

        // Re-link auth_identity from new customer → master customer in the DB
        const sql = postgres(process.env.DATABASE_URL!)
        try {
            const updated = await sql`
                UPDATE auth_identity
                SET app_metadata = jsonb_set(app_metadata, '{customer_id}', ${`"${masterCustomer.id}"`}::jsonb)
                WHERE app_metadata->>'customer_id' = ${newCustomerId}
                RETURNING id
            `
            if (updated.length > 0) {
                logger.info(`[OAuth Dedup] Re-linked ${updated.length} auth_identity record(s) to master customer ${masterCustomer.id}`)
            }

            // Also re-assign any orders linked to the new duplicate customer
            const ordersUpdated = await sql`
                UPDATE "order"
                SET customer_id = ${masterCustomer.id}
                WHERE customer_id = ${newCustomerId}
            `
            if (ordersUpdated.count > 0) {
                logger.info(`[OAuth Dedup] Re-assigned ${ordersUpdated.count} orders to master customer`)
            }
        } finally {
            await sql.end()
        }

        // Soft-delete the duplicate new customer
        await customerModule.deleteCustomers([newCustomerId])
        logger.info(`[OAuth Dedup] ✅ Soft-deleted duplicate customer ${newCustomerId} — user will log in as ${masterCustomer.id}`)

    } catch (err: any) {
        // Non-fatal: log but don't block
        logger.error(`[OAuth Dedup] Error during dedup for customer ${newCustomerId}: ${err.message}`)
    }
}

export const config: SubscriberConfig = {
    event: 'customer.created',
    context: {
        subscriberId: 'google-oauth-dedup'
    }
}
