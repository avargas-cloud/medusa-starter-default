/**
 * Delete all price rules to fix Admin UI display
 */

export default async function deletePriceRules({ container }: any) {
    const logger = container.resolve("logger")
    const knex = container.resolve("__pg_connection__")

    const log = (msg: string) => {
        console.log(msg)
        logger.info(msg)
    }

    log(`\n🗑️  DELETING PRICE RULES\n`)

    try {
        // Get count first
        const count = await knex("price_rule")
            .count("* as total")
            .whereNull("deleted_at")
            .first()

        log(`Found ${count?.total || 0} price rules`)

        if (!count?.total || count.total === 0) {
            log(`✅ No price rules to delete`)
            return { success: true, deleted: 0 }
        }

        // Delete all price rules
        const deleted = await knex("price_rule")
            .whereNull("deleted_at")
            .update({ deleted_at: knex.fn.now() })

        log(`\n✅ Deleted ${deleted} price rules`)
        log(`\n📝 Now prices will show in Admin UI "Prices" panel`)

        return { success: true, deleted }

    } catch (error: any) {
        log(`❌ Error: ${error.message}`)
        console.error(error.stack)
        throw error
    }
}
