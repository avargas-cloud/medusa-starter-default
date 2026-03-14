import knex from "knex"
import { MeiliSearch } from "meilisearch"
import * as dotenv from "dotenv"

dotenv.config({ path: "/home/alejo/webapps/ecopowertech-workspace/backend/.env" })

const db = knex({
    client: 'pg',
    connection: process.env.DATABASE_URL
})

const client = new MeiliSearch({
    host: process.env.MEILISEARCH_HOST!,
    apiKey: process.env.MEILISEARCH_API_KEY!
});

async function run() {
    console.log("Fetching customers from postgres...")

    // In Medusa v2, it's typically 'customer_group_customer'
    // Let's just fetch all customers first, then groups, then map in JS if raw query is hard, but let's try customer_group_customer
    const result = await db.raw(`
        SELECT 
            c.id, c.email, c.first_name, c.last_name, c.company_name, c.phone, c.has_account, c.metadata, c.created_at, c.updated_at,
            (
                SELECT json_agg(cg.name) 
                FROM customer_group_customer cgc
                JOIN customer_group cg ON cgc.customer_group_id = cg.id
                WHERE cgc.customer_id = c.id
            ) as group_names
        FROM customer c
    `);

    const customers = result.rows;
    console.log(`Found ${customers.length} customers.`);

    const docs = customers.map((c: any) => {
        const meta = c.metadata || {}
        const groupNames = c.group_names || []
        const price_level = groupNames.includes("Wholesale") ? "Wholesale" : "Retail"
        const customer_type = meta.qb_customer_type || meta.customer_type || "Standard"

        return {
            id: c.id,
            email: c.email,
            first_name: c.first_name || "",
            last_name: c.last_name || "",
            company_name: c.company_name || "",
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

    console.log("Pushing to Meilisearch...");
    await client.index("customers").updateDocuments(docs);
    console.log("Done.");
    process.exit(0);
}

run().catch(e => console.error(e))
