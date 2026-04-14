import postgres from "postgres";

/**
 * Check what metadata keys categories have with photo/image data
 */
async function checkCategoryMetadata() {
  const sql = postgres(process.env.DATABASE_URL!);
  const rows = await sql`
        SELECT name, metadata
        FROM product_category
        WHERE metadata IS NOT NULL
          AND metadata::text != 'null'
          AND metadata::text != '{}'
        LIMIT 10
    `;
  console.log("Categories with metadata:");
  for (const row of rows) {
    console.log(`\n${row.name}:`, JSON.stringify(row.metadata, null, 2));
  }
  await sql.end();
  process.exit(0);
}

checkCategoryMetadata().catch((e) => {
  console.error(e);
  process.exit(1);
});
