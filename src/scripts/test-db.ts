import { MedusaContainer } from "@medusajs/medusa"

export default async function ({ container }: { container: MedusaContainer }) {
    console.log("TESTING DB CONNECTION:")
    const pg = container.resolve("__pg_connection__") as any
    const res = await pg.raw("SELECT 1 as num")
    console.log("DB RESULT:", res.rows)
}
