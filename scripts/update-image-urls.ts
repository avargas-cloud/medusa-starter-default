import { Client } from "pg"
import dotenv from "dotenv"

dotenv.config()

async function updateImageURLs(dryRun = true) {
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    })

    try {
        await client.connect()
        console.log("🔄 Starting database URL updates...")
        console.log(`Mode: ${dryRun ? "DRY RUN (preview only)" : "LIVE (will update)"}`)
        console.log("=".repeat(60))

        let totalUpdated = 0

        // 1. Update product thumbnails
        console.log("\n📸 Processing product thumbnails...")
        const thumbnailResult = await updateProductThumbnails(client, dryRun)
        totalUpdated += thumbnailResult
        console.log(`  ${dryRun ? "Would update" : "Updated"} ${thumbnailResult} thumbnails`)

        // 2. Update image URLs in image table
        console.log("\n🖼️  Processing image table...")
        const imageResult = await updateImageTable(client, dryRun)
        totalUpdated += imageResult
        console.log(`  ${dryRun ? "Would update" : "Updated"} ${imageResult} images`)

        // 3. Update category images in metadata
        console.log("\n🏷️  Processing category images...")
        const categoryResult = await updateCategoryImages(client, dryRun)
        totalUpdated += categoryResult
        console.log(`  ${dryRun ? "Would update" : "Updated"} ${categoryResult} category images`)

        console.log("\n" + "=".repeat(60))
        console.log("📊 UPDATE SUMMARY")
        console.log("=".repeat(60))
        console.log(`Total URLs ${dryRun ? "to update" : "updated"}: ${totalUpdated}`)
        console.log("=".repeat(60))

        if (dryRun) {
            console.log("\n💡 This was a DRY RUN - no changes were made")
            console.log("   Run without --dry-run to execute the updates")
        } else {
            console.log("\n✅ Database updates completed!")
        }
    } catch (error) {
        console.error("❌ Update failed:", error)
        throw error
    } finally {
        await client.end()
    }
}

async function updateProductThumbnails(client: Client, dryRun: boolean): Promise<number> {
    const findQuery = `
        SELECT id, thumbnail 
        FROM product 
        WHERE thumbnail IS NOT NULL 
        AND thumbnail LIKE '%products/%/%'
    `

    const result = await client.query(findQuery)
    const products = result.rows

    if (dryRun) {
        console.log(`\n  Preview of ${Math.min(5, products.length)} thumbnails to update:`)
        products.slice(0, 5).forEach(p => {
            const newUrl = flattenURL(p.thumbnail)
            console.log(`    ${p.id}:`)
            console.log(`      Old: ${p.thumbnail}`)
            console.log(`      New: ${newUrl}`)
        })
        return products.length
    }

    for (const product of products) {
        const newUrl = flattenURL(product.thumbnail)
        await client.query(
            `UPDATE product SET thumbnail = $1, updated_at = NOW() WHERE id = $2`,
            [newUrl, product.id]
        )
    }

    return products.length
}

async function updateImageTable(client: Client, dryRun: boolean): Promise<number> {
    const findQuery = `
        SELECT id, url 
        FROM image 
        WHERE url IS NOT NULL 
        AND url LIKE '%products/%/%'
    `

    const result = await client.query(findQuery)
    const images = result.rows

    if (dryRun) {
        console.log(`\n  Preview of ${Math.min(5, images.length)} images to update:`)
        images.slice(0, 5).forEach(img => {
            console.log(`    ${img.id}:`)
            console.log(`      Old: ${img.url}`)
            console.log(`      New: ${flattenURL(img.url)}`)
        })
        return images.length
    }

    for (const image of images) {
        const newUrl = flattenURL(image.url)
        await client.query(
            `UPDATE image SET url = $1, updated_at = NOW() WHERE id = $2`,
            [newUrl, image.id]
        )
    }

    return images.length
}

async function updateCategoryImages(client: Client, dryRun: boolean): Promise<number> {
    const findQuery = `
        SELECT id, metadata 
        FROM product_category 
        WHERE metadata IS NOT NULL 
        AND metadata::text LIKE '%categories/%/%'
    `

    const result = await client.query(findQuery)
    const categories = result.rows

    if (dryRun) {
        console.log(`\n  Preview of ${Math.min(3, categories.length)} categories to update:`)
        categories.slice(0, 3).forEach(c => {
            const imageUrl = c.metadata?.image_url
            if (imageUrl) {
                console.log(`    ${c.id}:`)
                console.log(`      Old: ${imageUrl}`)
                console.log(`      New: ${flattenURL(imageUrl)}`)
            }
        })
        return categories.length
    }

    for (const category of categories) {
        const updatedMetadata = { ...category.metadata }

        if (updatedMetadata.image_url) {
            updatedMetadata.image_url = flattenURL(updatedMetadata.image_url)
        }

        await client.query(
            `UPDATE product_category SET metadata = $1, updated_at = NOW() WHERE id = $2`,
            [JSON.stringify(updatedMetadata), category.id]
        )
    }

    return categories.length
}

function flattenURL(url: string): string {
    if (!url) return url

    // Pattern: products/9599/image.jpg → products/image.jpg
    // Pattern: categories/123/banner.jpg → categories/banner.jpg

    const regex = /(products|categories)\/[^/]+\/([^/]+)$/
    return url.replace(regex, '$1/$2')
}

// Run script
const isDryRun = !process.argv.includes("--live")
updateImageURLs(isDryRun)
    .then(() => {
        process.exit(0)
    })
    .catch((err) => {
        console.error("❌ Script failed:", err)
        process.exit(1)
    })
