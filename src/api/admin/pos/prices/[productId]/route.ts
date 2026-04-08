import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/utils"

const WHOLESALE_PRICE_LIST_ID = "plist_01KFTSDZZNTQRSYNMB4YST1HYA"

interface PriceUpdateBody {
    retail_price: number
    wholesale_price: number
}

/** Update amount + raw_amount (Medusa v2 stores both) via Knex */
async function updatePriceById(knex: any, id: string, amount: number): Promise<void> {
    await knex.raw(
        `UPDATE price
         SET amount = ?,
             raw_amount = jsonb_build_object('value', ?::text, 'precision', 20),
             updated_at = NOW()
         WHERE id = ? AND deleted_at IS NULL`,
        [amount, String(amount), id]
    )
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    const logger = req.scope.resolve("logger")
    const productId = req.params.productId
    const { retail_price, wholesale_price } = req.body as PriceUpdateBody

    if (typeof retail_price !== "number" || typeof wholesale_price !== "number") {
        return res.status(400).json({ error: "retail_price and wholesale_price must be numbers" })
    }
    if (retail_price < 0 || wholesale_price < 0) {
        return res.status(400).json({ error: "Prices cannot be negative" })
    }
    if (wholesale_price > retail_price) {
        return res.status(400).json({ error: "Wholesale price cannot exceed retail price" })
    }

    // __pg_connection__ is a Knex instance in Medusa v2
    const knex = (req.scope as any).resolve("__pg_connection__")
    const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

    try {
        // 1. Get variant + price_set via Medusa graph
        const { data: variants } = await query.graph({
            entity: "product_variant",
            fields: ["id", "price_set.id"],
            filters: { product_id: productId },
        })

        if (!variants || variants.length === 0) {
            return res.status(404).json({ error: "Variant not found for this product" })
        }

        const variant = variants[0] as { id: string; price_set: { id: string } | null }
        const variant_id = variant.id
        const price_set_id = variant.price_set?.id

        if (!price_set_id) {
            return res.status(404).json({ error: "No price set linked to this variant" })
        }

        // 2. Fetch existing price rows for this price_set (raw SQL — reliable, no ORM surprises)
        const existing = await knex.raw(
            `SELECT id, price_list_id
             FROM price
             WHERE price_set_id = ? AND currency_code = 'usd' AND deleted_at IS NULL`,
            [price_set_id]
        )
        const rows: { id: string; price_list_id: string | null }[] = existing.rows

        const retailRow = rows.find((r) => !r.price_list_id)
        const wholesaleRow = rows.find((r) => r.price_list_id === WHOLESALE_PRICE_LIST_ID)

        // 3. Update retail (base) price
        if (retailRow) {
            await updatePriceById(knex, retailRow.id, retail_price)
        } else {
            logger.warn(`[pos-prices] No base USD price for price_set ${price_set_id} — inserting`)
            await knex.raw(
                `INSERT INTO price (id, price_set_id, currency_code, amount, raw_amount, rules_count, created_at, updated_at)
                 VALUES (?, ?, 'usd', ?, jsonb_build_object('value', ?::text, 'precision', 20), 0, NOW(), NOW())`,
                [`price_${Date.now()}_r`, price_set_id, retail_price, String(retail_price)]
            )
        }

        // 4. Update wholesale price
        if (wholesaleRow) {
            await updatePriceById(knex, wholesaleRow.id, wholesale_price)
        } else {
            logger.warn(`[pos-prices] No wholesale price for price_set ${price_set_id} — inserting`)
            await knex.raw(
                `INSERT INTO price (id, price_set_id, price_list_id, currency_code, amount, raw_amount, rules_count, created_at, updated_at)
                 VALUES (?, ?, ?, 'usd', ?, jsonb_build_object('value', ?::text, 'precision', 20), 0, NOW(), NOW())`,
                [`price_${Date.now()}_w`, price_set_id, WHOLESALE_PRICE_LIST_ID, wholesale_price, String(wholesale_price)]
            )
        }

        // 5. Targeted Meilisearch update (wait for indexing before returning)
        try {
            const { data: invItems } = await query.graph({
                entity: "product_variant",
                fields: ["inventory_items.inventory.id"],
                filters: { id: variant_id },
            })

            const invId: string | undefined =
                (invItems?.[0] as any)?.inventory_items?.[0]?.inventory?.id
            const docId = invId ?? variant_id

            const { MeiliSearch } = await import("meilisearch")
            const client = new MeiliSearch({
                host: process.env.MEILISEARCH_HOST!,
                apiKey: process.env.MEILISEARCH_API_KEY!,
            })

            const task = await client.index("inventory").updateDocuments([{
                id: docId,
                price: retail_price,
                pricesByList: { [WHOLESALE_PRICE_LIST_ID]: wholesale_price },
            }])

            await client.tasks.waitForTask(task.taskUid, { timeout: 8000 })
            logger.info(`[pos-prices] Meilisearch doc ${docId} updated (taskUid: ${task.taskUid})`)
        } catch (meiliErr: unknown) {
            const msg = meiliErr instanceof Error ? meiliErr.message : String(meiliErr)
            logger.warn(`[pos-prices] Meilisearch update failed (non-blocking): ${msg}`)
        }

        // 6. Verify: count price rows to detect zombies
        const countResult = await knex.raw(
            `SELECT COUNT(*) as cnt FROM price WHERE price_set_id = ? AND deleted_at IS NULL`,
            [price_set_id]
        )
        const priceCount = parseInt(countResult.rows[0].cnt, 10)
        logger.info(`[pos-prices] price_set ${price_set_id} now has ${priceCount} active price rows`)

        return res.status(200).json({ success: true, variant_id, price_set_id, price_rows: priceCount })
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`[pos-prices] Failed to update prices: ${msg}`)
        return res.status(500).json({ error: msg })
    }
}
