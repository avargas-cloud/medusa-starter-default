import { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";

/**
 * Check column types for product_variant table
 * Run with: npx medusa exec ./src/scripts/check-schema.ts
 */
export default async function checkSchema({ container }: ExecArgs) {
    console.log("\n🔍 Checking ProductVariant Schema via remote query...\n");

    // We don't have direct SQL access easily exposed in simple exec context typically without knex
    // But we can try to inspect the entity metadata from the MikroORM manager if available
    // or just assume standard Medusa v2 schema.

    // However, the effective behavior is what matters.
    // If I update with 1.5 and get 1, it's an integer.

    const productModuleService = container.resolve(Modules.PRODUCT);
    const query = container.resolve("query");

    // Let's create a dummy variant with decimal and see what happens (we already saw it truncating earlier)
    // Confirming truncation IS confirming integer type effectively.

    console.log("We observed 1.3125 -> 1 truncation earlier.");
    console.log("This strongly implies INTEGER / NUMERIC(x,0) columns.");

    // In Medusa v2, the default product schema defines these as:
    // weight: number (nullable)
    // length: number (nullable)
    // width: number (nullable)
    // height: number (nullable)

    // But MikroORM / Postgres type matters.
    // By default Medusa v1 used integers. v2 might have kept it for compatibility or default.

    // If we want decimals, we likely need to alter the column type.

    // Let's try to fetch the raw db config or do a raw query if possible?
    try {
        const pgConnection = container.resolve("db_connection"); // this might not exist with this name
        // Usually 'mikro-orm' entity manager
        const manager = container.resolve("manager");
        if (manager) {
            const knex = manager.getKnex();
            const info = await knex.raw(`
                SELECT column_name, data_type, numeric_precision, numeric_scale 
                FROM information_schema.columns 
                WHERE table_name = 'product_variant';
            `);
            console.table(info.rows.filter(r => ['weight', 'length', 'width', 'height'].includes(r.column_name)));
        }
    } catch (e) {
        console.log("Could not access Knex directly:", e.message);
    }
}
