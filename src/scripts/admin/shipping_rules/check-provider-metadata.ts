import "dotenv/config";
import { getSql } from "../lib/db.js";

async function checkProviderMetadata() {
  const sql = getSql();

  const result = await sql`
        SELECT provider_metadata
        FROM provider_identity
        WHERE provider = 'emailpass'
        AND entity_id = 'a.vargas@ecopowertech.com'
        AND deleted_at IS NULL
    `;

  console.log(
    "Provider Metadata:",
    JSON.stringify(result[0]?.provider_metadata, null, 2)
  );

  process.exit(0);
}

checkProviderMetadata();
