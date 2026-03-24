import { MedusaContainer } from "@medusajs/medusa"

export default async function ({ container }: { container: MedusaContainer }) {
    console.log("Creating sequences...")
    const pg = container.resolve("__pg_connection__") as any
    await pg.raw(`CREATE SEQUENCE IF NOT EXISTS custom_estimate_seq START 1000;`)
    await pg.raw(`CREATE SEQUENCE IF NOT EXISTS custom_order_seq START 10000;`)
    console.log("Sequences created successfully.")
}
