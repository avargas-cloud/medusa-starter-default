import * as dotenv from "dotenv";
import { Client } from "pg";

dotenv.config();

async function checkRecent() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });

  try {
    await db.connect();

    console.log(
      `🔍 Buscando CUALQUIER login de Google en los últimos 30 minutos...\n`
    );

    const auths = await db.query(`
      SELECT 
        ai.id AS auth_id, 
        ai.app_metadata, 
        pi.provider_metadata->>'email' AS google_email,
        ai.created_at
      FROM auth_identity ai
      JOIN provider_identity pi ON ai.id = pi.auth_identity_id
      WHERE ai.created_at > NOW() - INTERVAL '30 minutes'
      ORDER BY ai.created_at DESC;
    `);

    if (auths.rows.length === 0) {
      console.log(
        `❌ No se registró absolutamente NINGUNA identidad de Google en la base de datos en los últimos 30 minutos.`
      );
      console.log(
        `   (Esto significa que el login que acabas de hacer no pasó por Google, falló silenciosamente, o usó un email/password normal en vez del botón de Google)`
      );
    } else {
      console.log(`✅ Se encontraron estas identidades recientes:`);
      console.log(JSON.stringify(auths.rows, null, 2));
    }
  } catch (error) {
    console.error("❌ Error en el chequeo:", error);
  } finally {
    await db.end();
  }
}

checkRecent();
