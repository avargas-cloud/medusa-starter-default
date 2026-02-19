/**
 * sync-inventory-dimensions.ts
 *
 * Copies weight / height / width / length from the PARENT PRODUCT → inventory_item
 * Chain: inventory_item → product_variant → product (parent)
 *
 * Usage:
 *   npx medusa exec src/scripts/sync-inventory-dimensions.ts               ← dry run (default)
 *   DRY_RUN=false npx medusa exec src/scripts/sync-inventory-dimensions.ts ← full sync
 *   LIMIT=10 DRY_RUN=false npx medusa exec src/scripts/sync-inventory-dimensions.ts ← first 10
 */

const DRY_RUN = process.env.DRY_RUN !== "false"   // default: true
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT) : 9999

export default async function syncInventoryDimensions({ container }: { container: any }) {
    const knex = container.resolve("__pg_connection__") as any

    console.log("=".repeat(60))
    console.log(`🔍 Sync Inventory Dimensions (source: PRODUCT parent)`)
    console.log(`   DRY_RUN : ${DRY_RUN}`)
    console.log(`   LIMIT   : ${LIMIT === 9999 ? "all" : LIMIT}`)
    console.log("=".repeat(60))


    // ─── 1. Fetch links: inventory_item → variant → PRODUCT (parent) ─────────
    const links = await knex("product_variant_inventory_item as pvi")
        .join("inventory_item as ii", "ii.id", "pvi.inventory_item_id")
        .join("product_variant as pv", "pv.id", "pvi.variant_id")
        .join("product as p", "p.id", "pv.product_id")
        .select(
            "pvi.variant_id",
            "pvi.inventory_item_id",
            "pv.title        as variant_title",
            "pv.sku          as variant_sku",
            "p.title         as product_title",
            "p.weight        as product_weight",
            "p.height        as product_height",
            "p.width         as product_width",
            "p.length        as product_length",
            "ii.title        as inventory_title",
            "ii.sku          as inventory_sku",
            "ii.weight       as inventory_weight",
            "ii.height       as inventory_height",
            "ii.width        as inventory_width",
            "ii.length       as inventory_length",
        )
        .whereNull("pv.deleted_at")
        .whereNull("ii.deleted_at")
        .limit(LIMIT)

    console.log(`\n📦 Found ${links.length} inventory_item link(s)\n`)

    // ─── 2. Process each link ─────────────────────────────────────────────────
    let synced = 0
    let skipped = 0
    let noSource = 0
    const noSourceList: { sku: string; product: string }[] = []

    // Track items with incomplete attributes (some fields missing)
    const incomplete: { sku: string; product: string; missing: string[] }[] = []

    for (const row of links) {
        const hasInventoryDims = row.inventory_weight || row.inventory_height ||
            row.inventory_width || row.inventory_length

        // Already has dimensions → skip
        if (hasInventoryDims) {
            console.log(`⏭  SKIP  [${row.inventory_sku || row.inventory_item_id}] "${row.inventory_title}" — already has dimensions`)
            skipped++
            continue
        }

        const hasProductDims = row.product_weight || row.product_height ||
            row.product_width || row.product_length

        // Product has NO dimensions at all → no source
        if (!hasProductDims) {
            noSourceList.push({ sku: row.variant_sku || row.inventory_sku, product: row.product_title })
            noSource++
            continue
        }

        // Check which fields are missing (partial data)
        const missing: string[] = []
        if (!row.product_weight) missing.push("weight")
        if (!row.product_height) missing.push("height")
        if (!row.product_width) missing.push("width")
        if (!row.product_length) missing.push("length")

        if (missing.length > 0) {
            incomplete.push({
                sku: row.variant_sku || row.inventory_sku || row.inventory_item_id,
                product: row.product_title,
                missing
            })
        }

        // Sync whatever we have (partial is still better than nothing)
        console.log(`\n✅ SYNC  [${row.inventory_sku || row.inventory_item_id}] "${row.inventory_title}"`)
        console.log(`        Product : ${row.product_title}`)
        console.log(`        Variant : ${row.variant_title} (${row.variant_sku})`)
        console.log(`        Values  : weight=${row.product_weight ?? "❌"}  height=${row.product_height ?? "❌"}  width=${row.product_width ?? "❌"}  length=${row.product_length ?? "❌"}`)
        if (missing.length > 0) {
            console.log(`        ⚠️  INCOMPLETE — missing: ${missing.join(", ")}`)
        }

        if (!DRY_RUN) {
            await knex("inventory_item")
                .where("id", row.inventory_item_id)
                .update({
                    weight: row.product_weight ?? null,
                    height: row.product_height ?? null,
                    width: row.product_width ?? null,
                    length: row.product_length ?? null,
                    updated_at: new Date(),
                })
            console.log(`        → Written to DB ✔`)
        } else {
            console.log(`        → [DRY RUN] Would write to DB`)
        }

        synced++
    }

    // ─── 3. Summary ───────────────────────────────────────────────────────────
    console.log("\n" + "=".repeat(60))
    console.log(`📊 Summary`)
    console.log(`   Synced              : ${synced}`)
    console.log(`   Skipped (has dims)  : ${skipped}`)
    console.log(`   No source on product: ${noSource}`)
    console.log(`   Incomplete attrs    : ${incomplete.length}`)

    if (incomplete.length > 0) {
        console.log("\n⚠️  ATRIBUTOS INCOMPLETOS — estos productos necesitan revisión manual:")
        console.log("-".repeat(60))
        incomplete.forEach((item, i) => {
            console.log(`  ${i + 1}. [${item.sku}] ${item.product}`)
            console.log(`     Missing: ${item.missing.join(", ")}`)
        })
        console.log("-".repeat(60))
    }

    if (noSourceList.length > 0) {
        console.log("\n❌ SIN FUENTE — estos productos no tienen dimensiones en el admin (ingresar manualmente):")
        console.log("-".repeat(60))
        noSourceList.forEach((item, i) => {
            console.log(`  ${i + 1}. [${item.sku}] ${item.product}`)
        })
        console.log("-".repeat(60))
    }

    if (DRY_RUN) {
        console.log(`\n   ⚠️  DRY RUN — nothing was written.`)
        console.log(`   To apply: DRY_RUN=false npx medusa exec src/scripts/sync-inventory-dimensions.ts`)
    } else {
        console.log(`\n   ✅ DONE — ${synced} inventory item(s) updated.`)
    }
    console.log("=".repeat(60))
}
