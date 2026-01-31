export default async function ({ container }: any) {
    const knex = container.resolve("__pg_connection__")

    console.log("🧹 HARD DELETE ALL SOFT-DELETED ATTRIBUTE LINKS")
    console.log("=".repeat(80))

    // Count soft-deleted links
    const softDeleted = await knex("product_product_productattributes_attribute_value")
        .whereNotNull("deleted_at")
        .count("* as count")

    const count = parseInt(softDeleted[0].count)
    console.log(`\n📊 Found ${count} soft-deleted links to permanently remove`)

    if (count === 0) {
        console.log("\n✅ No soft-deleted links found - database is clean!")
        return
    }

    // Get sample of what we're deleting
    const sample = await knex("product_product_productattributes_attribute_value")
        .select("product_id", "attribute_value_id", "deleted_at")
        .whereNotNull("deleted_at")
        .limit(5)

    console.log("\n🔍 Sample of links to delete:")
    sample.forEach((link: any) => {
        console.log(`   ${link.product_id.slice(0, 15)} → ${link.attribute_value_id.slice(0, 15)} (deleted: ${link.deleted_at})`)
    })

    console.log(`\n⚠️  Will permanently delete ${count} soft-deleted links...`)

    // HARD DELETE
    const deleted = await knex("product_product_productattributes_attribute_value")
        .whereNotNull("deleted_at")
        .del()

    console.log(`\n✅ Successfully hard-deleted ${deleted} soft-deleted links`)
    console.log("\n" + "=".repeat(80))
}
