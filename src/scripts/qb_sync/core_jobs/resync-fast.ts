import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

export default async function syncAllCustomersFast({ container }: ExecArgs) {
    const logger = container.resolve("logger")
    const customerModule = container.resolve(Modules.CUSTOMER)

    logger.info(`Starting fast customer sync...`)

    const { MeiliSearch } = await import("meilisearch")
    const client = new MeiliSearch({
        host: process.env.MEILISEARCH_HOST!,
        apiKey: process.env.MEILISEARCH_API_KEY!
    })

    try {
        const [customers, count] = await customerModule.listAndCountCustomers({}, {
            select: ["id", "email", "first_name", "last_name", "company_name", "phone", "has_account", "metadata", "created_at", "updated_at"],
            relations: ["groups"],
            take: 10000
        })

        const docs = customers.map((c: any) => {
            const meta = (c.metadata as any) || {}
            const groupNames = c.groups?.map((g: any) => g.name) || []
            const price_level = groupNames.includes("Wholesale") ? "Wholesale" : "Retail"
            const customer_type = meta.qb_customer_type || meta.customer_type || "Standard"

            return {
                id: c.id,
                email: c.email,
                first_name: c.first_name || "",
                last_name: c.last_name || "",
                company_name: (c as any).company_name || "",
                phone: c.phone || "",
                has_account: c.has_account,
                status: c.has_account ? "Registered" : "Guest",
                list_id: meta.qb_list_id || "",
                customer_type,
                price_level,
                groups: groupNames,
                updated_at: new Date(c.updated_at).getTime(),
                created_at: new Date(c.created_at).getTime(),
            }
        })

        logger.info(`Pushing ${count} docs to Meilisearch...`)
        const index = client.index("customers")
        await index.updateDocuments(docs)
        logger.info(`Done! Exiting.`)
    } catch (e) {
        logger.error(`Error: ${e}`)
    }
    process.exit(0)
}
