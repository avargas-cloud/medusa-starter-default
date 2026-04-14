import { loadEnv } from "@medusajs/utils";
import postgres from "postgres";
loadEnv("development", process.cwd());

const dbUrl = process.env.DATABASE_URL;
const sql = postgres(dbUrl!);

(async () => {
  const authId = "authid_31159cf64b1fe9ac92b79a10";
  try {
    const res =
      await sql`SELECT id, app_metadata FROM auth_identity WHERE id = ${authId}`;
    console.log(`🔍 Inspecting AuthIdentity: ${authId}`);
    if (res.length > 0) {
      console.log(`Metadata:`, JSON.stringify(res[0].app_metadata, null, 2));
    } else {
      console.log("❌ Record not found");
    }
  } catch (e) {
    console.error(e);
  }
  await sql.end();
})();
