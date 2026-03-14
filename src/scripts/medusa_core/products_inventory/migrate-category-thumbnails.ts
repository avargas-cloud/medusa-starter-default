import { config } from "dotenv"
import { Client } from "pg"

config()

/**
 * Migration script to copy category thumbnails from metadata.thumbnail
 * to the new native thumbnail column.
 * 
 * Run this after the database migration has been executed on Railway.
 */
async function migrateThumbnails() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL,
    })

    try {
        await client.connect()
        console.log("✅ Connected to database")

        // Update categories that have metadata.thumbnail but no direct thumbnail
        const result = await client.query(`
      UPDATE product_category
      SET thumbnail = metadata->>'thumbnail'
      WHERE metadata->>'thumbnail' IS NOT NULL
        AND (thumbnail IS NULL OR thumbnail = '');
    `)

        console.log(`\n✅ Migrated ${result.rowCount} category thumbnails`)

        // Verify the migration
        const verification = await client.query(`
      SELECT 
        COUNT(*) FILTER (WHERE thumbnail IS NOT NULL) as with_thumbnail,
        COUNT(*) FILTER (WHERE metadata->>'thumbnail' IS NOT NULL) as with_metadata_thumbnail,
        COUNT(*) as total
      FROM product_category;
    `)

        console.log("\n📊 Verification:")
        console.log(`   Total categories: ${verification.rows[0].total}`)
        console.log(`   With thumbnail column: ${verification.rows[0].with_thumbnail}`)
        console.log(`   With metadata.thumbnail: ${verification.rows[0].with_metadata_thumbnail}`)

        // Show sample categories
        const sample = await client.query(`
      SELECT id, name, thumbnail, metadata->>'thumbnail' as metadata_thumb
      FROM product_category
      WHERE thumbnail IS NOT NULL
      LIMIT 5;
    `)

        console.log("\n📷 Sample categories with thumbnails:")
        sample.rows.forEach((row) => {
            console.log(`   ${row.name}: ${row.thumbnail?.substring(0, 50)}...`)
        })

    } catch (error) {
        console.error("\n❌ Migration failed:", error)
        throw error
    } finally {
        await client.end()
        console.log("\n✅ Database connection closed")
    }
}

migrateThumbnails()
    .then(() => {
        console.log("\n🎉 Migration completed successfully!")
        process.exit(0)
    })
    .catch((error) => {
        console.error("\n💥 Migration failed:", error)
        process.exit(1)
    })
